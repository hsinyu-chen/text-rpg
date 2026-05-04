import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TwoCallOrchestratorService } from './two-call-orchestrator.service';
import { TwoCallTurnEngine } from './two-call-turn-engine.service';
import { ContextBuilderService } from '../context-builder.service';
import { ContentParserService } from '../content-parser.service';
import { StreamProcessorService } from '../stream-processor.service';
import { GameStateService } from '../game-state.service';
import { LanguageService } from '../language.service';
import { KnowledgeService } from '../knowledge.service';
import { LLMProviderRegistryService } from '../llm-provider-registry.service';
import { CostService } from '../cost.service';
import { PostProcessorService } from '../post-processor.service';
import { MockLLMProvider } from '@app/core/testing/mock-llm-provider';
import type { ResolverOutput } from '@app/core/constants/engine-protocol-two-call';
import type { ChatMessage } from '@app/core/models/types';

function resolverJson(payload: ResolverOutput): string {
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
    let messagesSignal: ReturnType<typeof signal<ChatMessage[]>>;
    let messages: ChatMessage[];
    const updateMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
        messages = updater(messages);
        messagesSignal.set(messages);
    };

    beforeEach(() => {
        mockProvider = new MockLLMProvider();
        messages = [];
        messagesSignal = signal<ChatMessage[]>([]);

        const fakeRegistry = {
            getActive: () => mockProvider,
            getActiveConfig: () => ({}),
            activeProvider: signal(mockProvider)
        };

        const fakeState: Partial<GameStateService> = {
            kbCacheName: signal<string | null>(null),
            systemInstructionCache: signal('SYS'),
            loadedFiles: signal(new Map()),
            // Intent injections — empty for narrator-side, populated on the resolver side via dynamic.
            dynamicActionInjection: signal(''),
            dynamicContinueInjection: signal(''),
            dynamicFastforwardInjection: signal(''),
            dynamicSystemInjection: signal(''),
            dynamicSaveInjection: signal(''),
            dynamicProtocolResolverInjection: signal('RESOLVER PROTOCOL {{USER_INPUT}}'),
            dynamicProtocolNarratorInjection: signal('NARRATOR PROTOCOL'),
            dynamicProtocolSingleInjection: signal(''),
            dynamicCorrectionInjection: signal(''),
            dynamicSystemMainInjection: signal(''),
            postProcessScript: signal(''),
            messages: messagesSignal,
            contextMode: signal('full'),
            saveContextMode: signal('full'),
            config: signal({ outputLanguage: 'default' }),
            // Required by ContextBuilder.getLLMHistory's helpers
            currentKbHash: signal(''),
            kbCacheTokens: signal(0),
            kbCacheHash: signal<string | null>(null)
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
                { provide: GameStateService, useValue: fakeState },
                { provide: LLMProviderRegistryService, useValue: fakeRegistry }
            ]
        });
    });

    function getEngine(): TwoCallTurnEngine {
        return TestBed.inject(TwoCallTurnEngine);
    }

    function pushUser(text: string, extra: Partial<ChatMessage> = {}) {
        messages.push({ id: 'u', role: 'user', content: text, parts: [{ text }], ...extra });
        messagesSignal.set([...messages]);
    }

    function runtime(text: string) {
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
            updateMessages
        };
    }

    it('drives resolver → truncate → narrator with no broken steps', async () => {
        pushUser('walk forward');

        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: 'reach plaza',
            ideal_strength: 'pragmatic',
            steps: [
                { action: 'walk', action_type: 'movement', target: '', dialogue: '', mood: 'calm', state_changes: [], event_type: 'ambient', ideal_status: 'intact', break_reason: '', npc_reactions: [], ambient: '' }
            ],
            interrupted: false,
            interrupted_at_step: 0
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
            steps: [
                { action: 'walk to farmer', action_type: 'movement', target: 'farmer', dialogue: '', mood: 'calm', state_changes: [], event_type: 'ambient', ideal_status: 'intact', break_reason: '', npc_reactions: [], ambient: '' },
                { action: 'reach for handshake', action_type: 'physical', target: 'farmer', dialogue: '', mood: 'friendly', state_changes: [], event_type: 'precondition_break', ideal_status: 'broken', break_reason: 'farmer stepped back', npc_reactions: [], ambient: '' },
                { action: 'speak greeting', action_type: 'speech', target: 'farmer', dialogue: 'TRUNCATED-LINE-DO-NOT-LEAK', mood: 'friendly', state_changes: [], event_type: 'ambient', ideal_status: 'intact', break_reason: '', npc_reactions: [], ambient: '' }
            ],
            interrupted: true,
            interrupted_at_step: 2
        }));
        mockProvider.enqueueJsonStream(narratorJson('Farmer stepped back.'));

        const engine = getEngine();
        await engine.runTurn(runtime('shake hands and chat'));

        const narratorCall = mockProvider.calls[1];
        const narratorText = narratorCall.contents[narratorCall.contents.length - 1].parts[0].text!;

        // The truncated dialogue must not survive into the narrator input.
        expect(narratorText).not.toContain('TRUNCATED-LINE-DO-NOT-LEAK');
        // The break_reason from the broken step DOES propagate.
        expect(narratorText).toContain('farmer stepped back');
        expect(narratorText).toContain('"interrupted": true');
    });

    it('truncates when only a single broken step exists', async () => {
        pushUser('cast fireball');
        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: 'cast fireball',
            ideal_strength: 'desperate',
            steps: [
                { action: 'cast', action_type: 'magic', target: 'goblin', dialogue: '', mood: 'tense', state_changes: [], event_type: 'precondition_break', ideal_status: 'broken', break_reason: 'no mana', npc_reactions: [], ambient: '' }
            ],
            interrupted: true,
            interrupted_at_step: 1
        }));
        mockProvider.enqueueJsonStream(narratorJson('No mana.'));

        const engine = getEngine();
        await engine.runTurn(runtime('cast fireball'));

        const narratorText = mockProvider.calls[1].contents[mockProvider.calls[1].contents.length - 1].parts[0].text!;
        expect(narratorText).toContain('no mana');
    });

    it('recomputes interrupted from the steps array, ignoring the model-reported flag', async () => {
        pushUser('do thing');
        // Model claims interrupted=false, but step 1 is actually broken.
        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: 'X',
            ideal_strength: 'pragmatic',
            steps: [
                { action: 'a', action_type: 'movement', target: '', dialogue: '', mood: '', state_changes: [], event_type: 'ambient', ideal_status: 'broken', break_reason: 'reason from broken step', npc_reactions: [], ambient: '' }
            ],
            interrupted: false,
            interrupted_at_step: 0
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
            ideal_outcome: '', ideal_strength: 'pragmatic', steps: [], interrupted: false, interrupted_at_step: 0
        }));
        mockProvider.enqueueJsonStream(narratorJson('s'));

        const engine = getEngine();
        await engine.runTurn(runtime('x'));

        const resolverSchema = mockProvider.calls[0].genConfig.responseSchema as { properties?: Record<string, unknown> };
        const narratorSchema = mockProvider.calls[1].genConfig.responseSchema as { properties?: Record<string, unknown> };
        expect(Object.keys(resolverSchema.properties ?? {})).toContain('steps');
        expect(Object.keys(narratorSchema.properties ?? {})).toContain('story');
        expect(Object.keys(narratorSchema.properties ?? {})).not.toContain('steps');
    });

    it('injects {{IDEAL_OUTCOME_CONSTRAINT}} into the resolver call when the latest user msg supplied userIdealOutcome', async () => {
        pushUser('walk forward', { userIdealOutcome: 'reach the plaza unseen' });

        // Override the resolver protocol to include the slot for this test.
        const fakeState = TestBed.inject(GameStateService) as unknown as { dynamicProtocolResolverInjection: { set: (v: string) => void } };
        fakeState.dynamicProtocolResolverInjection.set('RESOLVER PROTOCOL\n\n{{IDEAL_OUTCOME_CONSTRAINT}}\n\n{{USER_INPUT}}');

        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: 'reach the plaza unseen',
            ideal_strength: 'pragmatic',
            steps: [
                { action: 'walk', action_type: 'movement', target: '', dialogue: '', mood: 'calm', state_changes: [], event_type: 'ambient', ideal_status: 'intact', break_reason: '', npc_reactions: [], ambient: '' }
            ],
            interrupted: false,
            interrupted_at_step: 0
        }));
        mockProvider.enqueueJsonStream(narratorJson('Walked.'));

        const engine = getEngine();
        await engine.runTurn(runtime('walk forward'));

        const resolverCall = mockProvider.calls[0];
        const resolverTail = resolverCall.contents[resolverCall.contents.length - 1].parts[0].text!;
        // The constraint paragraph (with the user-supplied text echoed) must reach the resolver.
        expect(resolverTail).toContain('reach the plaza unseen');
        // Slot was substituted, not left as a literal placeholder.
        expect(resolverTail).not.toContain('{{IDEAL_OUTCOME_CONSTRAINT}}');
    });

    it('leaves the resolver protocol slot empty when no userIdealOutcome was supplied', async () => {
        pushUser('walk forward');

        const fakeState = TestBed.inject(GameStateService) as unknown as { dynamicProtocolResolverInjection: { set: (v: string) => void } };
        fakeState.dynamicProtocolResolverInjection.set('RESOLVER PROTOCOL\n\n{{IDEAL_OUTCOME_CONSTRAINT}}\n\n{{USER_INPUT}}');

        mockProvider.enqueueJsonStream(resolverJson({
            ideal_outcome: '', ideal_strength: 'pragmatic', steps: [], interrupted: false, interrupted_at_step: 0
        }));
        mockProvider.enqueueJsonStream(narratorJson('s'));

        const engine = getEngine();
        await engine.runTurn(runtime('walk forward'));

        const resolverTail = mockProvider.calls[0].contents[mockProvider.calls[0].contents.length - 1].parts[0].text!;
        expect(resolverTail).not.toContain('{{IDEAL_OUTCOME_CONSTRAINT}}');
        // No constraint heading is injected.
        expect(resolverTail).not.toContain('User-declared ideal_outcome');
        expect(resolverTail).not.toContain('使用者聲明的 ideal_outcome');
    });

    it('reports narrator-only contextTokens so the sidebar bar reflects post-turn cache occupancy, not the cost-billable sum', async () => {
        pushUser('go');
        mockProvider.enqueueJsonStream(
            resolverJson({ ideal_outcome: '', ideal_strength: 'pragmatic', steps: [], interrupted: false, interrupted_at_step: 0 }),
            { usage: { prompt: 100, candidates: 30, cached: 50 } }
        );
        mockProvider.enqueueJsonStream(narratorJson('s'),
            { usage: { prompt: 200, candidates: 40, cached: 150 } }
        );

        const engine = getEngine();
        const result = await engine.runTurn(runtime('go'));

        // turnUsage.prompt (300) + candidates (70) = 370 — the cost-billable sum.
        // contextTokens must be the narrator-only view (200 + 40 = 240) so the
        // sidebar context bar doesn't double-count both calls.
        expect(result.contextTokens).toBe(240);
        expect(result.turnUsage.prompt).toBe(300);
    });

    it('combines usage metadata from both calls', async () => {
        pushUser('y');
        mockProvider.enqueueJsonStream(
            resolverJson({ ideal_outcome: '', ideal_strength: 'pragmatic', steps: [], interrupted: false, interrupted_at_step: 0 }),
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
