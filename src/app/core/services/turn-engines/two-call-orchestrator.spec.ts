import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TwoCallOrchestratorService } from './two-call-orchestrator.service';
import { TwoCallTurnEngine } from './two-call-turn-engine.service';
import { ContextBuilderService, BuildContext } from '../context-builder.service';
import { ContentParserService } from '../content-parser.service';
import { StreamProcessorService } from '../stream-processor.service';
import { GameStateService } from '../game-state.service';
import { LanguageService } from '../language.service';
import { KnowledgeService } from '../knowledge.service';
import { CostService } from '../cost.service';
import { PostProcessorService } from '../post-processor.service';
import { MockLLMProvider } from '@app/core/testing/mock-llm-provider';
import type {
    AnalysisStep,
    ResolverResponse,
    StructuredAnalysis
} from '@app/core/constants/engine-protocol-structured';
import type { ChatMessage } from '@app/core/models/types';

function step(overrides: Partial<AnalysisStep> = {}): AnalysisStep {
    return {
        action: 'walk',
        pc_dialogue: '',
        mood: '',
        risk_factors: [],
        outcome: '成功',
        breaks_ideal: false,
        npc_reactions: [],
        object_reactions: [],
        ...overrides
    };
}

function analysis(overrides: Partial<StructuredAnalysis> = {}): StructuredAnalysis {
    return {
        scene_snapshot: { time_hhmm: '12:00', environment: '', present_npcs: [], key_objects: [] },
        steps: [],
        random_event: { triggered: false, description: '' },
        ...overrides
    };
}

function resolverJson(payload: ResolverResponse): string {
    return JSON.stringify(payload);
}

function narratorJson(story: string, summary = 's'): string {
    return JSON.stringify({
        story,
        summary,
        interrupted_acknowledged: true
    });
}

describe('two-call orchestrator integration', () => {
    let mockProvider: MockLLMProvider;
    let messages: ChatMessage[];
    const updateMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
        messages = updater(messages);
    };

    beforeEach(() => {
        mockProvider = new MockLLMProvider();
        messages = [];

        const fakeState: Partial<GameStateService> = {
            config: signal({ outputLanguage: 'default' }),
            postProcessScript: signal('')
        } as unknown as Partial<GameStateService>;

        TestBed.configureTestingModule({
            providers: [
                TwoCallOrchestratorService,
                TwoCallTurnEngine,
                ContextBuilderService,
                ContentParserService,
                StreamProcessorService,
                PostProcessorService,
                LanguageService,
                CostService,
                KnowledgeService,
                { provide: GameStateService, useValue: fakeState }
            ]
        });
    });

    function getEngine(): TwoCallTurnEngine {
        return TestBed.inject(TwoCallTurnEngine);
    }

    function pushUser(text: string, extra: Partial<ChatMessage> = {}) {
        messages.push({ id: 'u', role: 'user', content: text, parts: [{ text }], ...extra });
    }

    function buildCtx(overrides: Partial<BuildContext> = {}): BuildContext {
        return {
            messages,
            contextMode: 'full',
            saveContextMode: 'full',
            smartContextTurns: 10,
            systemInstructionCache: 'SYS',
            loadedFiles: new Map(),
            kbCacheName: null,
            providerCapabilities: mockProvider.getCapabilities(),
            dynamicAction: '',
            dynamicContinue: '',
            dynamicFastforward: '',
            dynamicSystem: '',
            dynamicSave: '',
            dynamicProtocolResolver: 'RESOLVER PROTOCOL {{USER_INPUT}}',
            dynamicProtocolNarrator: 'NARRATOR PROTOCOL',
            dynamicProtocolSingle: '',
            dynamicCorrection: '',
            engineMode: 'two-call',
            ...overrides
        };
    }

    function runtime(text: string, ctxOverrides: Partial<BuildContext> = {}) {
        return {
            provider: mockProvider,
            providerConfig: {},
            cachedContentName: undefined,
            systemInstruction: 'SYS',
            history: [{ role: 'user' as const, parts: [{ text }] }],
            intent: 'action',
            outputLanguage: 'default',
            modelMsgId: 'm1',
            signal: new AbortController().signal,
            updateMessages,
            buildContext: buildCtx(ctxOverrides)
        };
    }

    it('drives resolver → truncate → narrator with no broken steps', async () => {
        pushUser('walk forward');

        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: 'reach plaza',
            ideal_strength: 'pragmatic',
            analysis: analysis({ steps: [step({ action: 'walk' })] })
        }));
        mockProvider.enqueueJsonStream(narratorJson('She walked forward.'));

        const engine = getEngine();
        const result = await engine.runTurn(runtime('walk forward'));

        expect(mockProvider.calls).toHaveLength(2);
        expect(result.finalStory).toContain('walked');

        // Narrator must NOT see the original user input string.
        const narratorCall = mockProvider.calls[1];
        const narratorTail = narratorCall.contents[narratorCall.contents.length - 1];
        const narratorText = narratorTail.parts[0].text!;
        expect(narratorText).not.toContain('walk forward');
        expect(narratorText).toContain('NARRATOR PROTOCOL');
        expect(narratorText).toContain('"interrupted": false');
    });

    it('truncates after the first broken step and drops later dialogue from narrator input', async () => {
        pushUser('shake hands and chat');

        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: 'shake hands then chat',
            ideal_strength: 'pragmatic',
            analysis: analysis({
                steps: [
                    step({ action: 'walk to farmer' }),
                    step({ action: 'reach for handshake', breaks_ideal: true, outcome: '失敗 - farmer stepped back' }),
                    step({ action: 'speak greeting', pc_dialogue: 'TRUNCATED-LINE-DO-NOT-LEAK' })
                ]
            })
        }));
        mockProvider.enqueueJsonStream(narratorJson('Farmer stepped back.'));

        const engine = getEngine();
        await engine.runTurn(runtime('shake hands and chat'));

        const narratorCall = mockProvider.calls[1];
        const narratorText = narratorCall.contents[narratorCall.contents.length - 1].parts[0].text!;

        // The truncated step's PC dialogue must not survive into the narrator input.
        expect(narratorText).not.toContain('TRUNCATED-LINE-DO-NOT-LEAK');
        // The breaking step's outcome DOES propagate (it's the last step in truncated_analysis).
        expect(narratorText).toContain('farmer stepped back');
        expect(narratorText).toContain('"interrupted": true');
    });

    it('truncates when only a single broken step exists', async () => {
        pushUser('cast fireball');
        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: 'cast fireball',
            ideal_strength: 'desperate',
            analysis: analysis({ steps: [step({ action: 'cast', breaks_ideal: true, outcome: '失敗 - no mana' })] })
        }));
        mockProvider.enqueueJsonStream(narratorJson('No mana.'));

        const engine = getEngine();
        await engine.runTurn(runtime('cast fireball'));

        const narratorText = mockProvider.calls[1].contents[mockProvider.calls[1].contents.length - 1].parts[0].text!;
        expect(narratorText).toContain('no mana');
    });

    it('derives interrupted from breaks_ideal, not from any model-supplied flag', async () => {
        pushUser('do thing');
        // Note: the new schema has no `interrupted` at the resolver level — the program
        // computes it. This test confirms a single broken step produces interrupted=true
        // in the narrator input regardless of any side-channel flag.
        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: 'X',
            ideal_strength: 'pragmatic',
            analysis: analysis({ steps: [step({ action: 'a', breaks_ideal: true, outcome: '失敗 - reason from broken step' })] })
        }));
        mockProvider.enqueueJsonStream(narratorJson('s'));

        const engine = getEngine();
        await engine.runTurn(runtime('do thing'));

        const narratorText = mockProvider.calls[1].contents[mockProvider.calls[1].contents.length - 1].parts[0].text!;
        expect(narratorText).toContain('"interrupted": true');
        expect(narratorText).toContain('reason from broken step');
    });

    it('uses the resolver schema on call 1 and the narrator schema on call 2', async () => {
        pushUser('x');
        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: '', ideal_strength: 'pragmatic', analysis: analysis()
        }));
        mockProvider.enqueueJsonStream(narratorJson('s'));

        const engine = getEngine();
        await engine.runTurn(runtime('x'));

        const resolverSchema = mockProvider.calls[0].genConfig.responseSchema as { properties?: Record<string, unknown> };
        const narratorSchema = mockProvider.calls[1].genConfig.responseSchema as { properties?: Record<string, unknown> };
        expect(Object.keys(resolverSchema.properties ?? {})).toContain('analysis');
        expect(Object.keys(narratorSchema.properties ?? {})).toContain('story');
        expect(Object.keys(narratorSchema.properties ?? {})).not.toContain('analysis');
    });

    it('injects {{IDEAL_OUTCOME_CONSTRAINT}} into the resolver call when the latest user msg supplied userIdealOutcome', async () => {
        pushUser('walk forward', { userIdealOutcome: 'reach the plaza unseen' });

        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: 'reach the plaza unseen',
            ideal_strength: 'pragmatic',
            analysis: analysis({ steps: [step({ action: 'walk' })] })
        }));
        mockProvider.enqueueJsonStream(narratorJson('Walked.'));

        const engine = getEngine();
        await engine.runTurn(runtime('walk forward', {
            dynamicProtocolResolver: 'RESOLVER PROTOCOL\n\n{{IDEAL_OUTCOME_CONSTRAINT}}\n\n{{USER_INPUT}}'
        }));

        const resolverCall = mockProvider.calls[0];
        const resolverTail = resolverCall.contents[resolverCall.contents.length - 1].parts[0].text!;
        expect(resolverTail).toContain('reach the plaza unseen');
        expect(resolverTail).not.toContain('{{IDEAL_OUTCOME_CONSTRAINT}}');
    });

    it('leaves the resolver protocol slot empty when no userIdealOutcome was supplied', async () => {
        pushUser('walk forward');

        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: '', ideal_strength: 'pragmatic', analysis: analysis()
        }));
        mockProvider.enqueueJsonStream(narratorJson('s'));

        const engine = getEngine();
        await engine.runTurn(runtime('walk forward', {
            dynamicProtocolResolver: 'RESOLVER PROTOCOL\n\n{{IDEAL_OUTCOME_CONSTRAINT}}\n\n{{USER_INPUT}}'
        }));

        const resolverTail = mockProvider.calls[0].contents[mockProvider.calls[0].contents.length - 1].parts[0].text!;
        expect(resolverTail).not.toContain('{{IDEAL_OUTCOME_CONSTRAINT}}');
        expect(resolverTail).not.toContain('User-declared ideal_outcome');
        expect(resolverTail).not.toContain('使用者聲明的 ideal_outcome');
    });

    it('reports narrator-only contextTokens so the sidebar bar reflects post-turn cache occupancy, not the cost-billable sum', async () => {
        pushUser('go');
        mockProvider.enqueueJsonStream(
            resolverJson({ ideal_outcome: '', ideal_strength: 'pragmatic', analysis: analysis() }),
            { usage: { prompt: 100, candidates: 30, cached: 50 } }
        );
        mockProvider.enqueueJsonStream(narratorJson('s'),
            { usage: { prompt: 200, candidates: 40, cached: 150 } }
        );

        const engine = getEngine();
        const result = await engine.runTurn(runtime('go'));

        expect(result.contextTokens).toBe(240);
        expect(result.turnUsage.prompt).toBe(300);
    });

    it('combines usage metadata from both calls', async () => {
        pushUser('y');
        mockProvider.enqueueJsonStream(
            resolverJson({ ideal_outcome: '', ideal_strength: 'pragmatic', analysis: analysis() }),
            { usage: { prompt: 100, candidates: 30, cached: 50 } }
        );
        mockProvider.enqueueJsonStream(narratorJson('s'),
            { usage: { prompt: 200, candidates: 40, cached: 150 } }
        );

        const engine = getEngine();
        const result = await engine.runTurn(runtime('y'));

        expect(result.turnUsage.prompt).toBe(300);
        expect(result.turnUsage.candidates).toBe(70);
        expect(result.turnUsage.cached).toBe(200);
    });
});
