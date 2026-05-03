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
import { MockLLMProvider } from '../../testing/mock-llm-provider';
import type { ResolverOutput } from '../../constants/engine-protocol-two-call';
import type { ChatMessage } from '../../models/types';

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
    let messages: ChatMessage[];
    const updateMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
        messages = updater(messages);
    };

    beforeEach(() => {
        mockProvider = new MockLLMProvider();
        messages = [];

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
            messages: signal([]),
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

    function pushUser(text: string) {
        messages.push({ id: 'u', role: 'user', content: text, parts: [{ text }] });
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
        const result = await engine.runTurn({
            history: [{ role: 'user', parts: [{ text: 'walk forward' }] }],
            intent: 'action',
            outputLanguage: 'default',
            modelMsgId: 'm1',
            signal: new AbortController().signal,
            updateMessages
        });

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
        await engine.runTurn({
            history: [{ role: 'user', parts: [{ text: 'shake hands and chat' }] }],
            intent: 'action',
            outputLanguage: 'default',
            modelMsgId: 'm1',
            signal: new AbortController().signal,
            updateMessages
        });

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
        await engine.runTurn({
            history: [{ role: 'user', parts: [{ text: 'cast fireball' }] }],
            intent: 'action',
            outputLanguage: 'default',
            modelMsgId: 'm1',
            signal: new AbortController().signal,
            updateMessages
        });

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
        await engine.runTurn({
            history: [{ role: 'user', parts: [{ text: 'do thing' }] }],
            intent: 'action',
            outputLanguage: 'default',
            modelMsgId: 'm1',
            signal: new AbortController().signal,
            updateMessages
        });

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
        await engine.runTurn({
            history: [{ role: 'user', parts: [{ text: 'x' }] }],
            intent: 'action',
            outputLanguage: 'default',
            modelMsgId: 'm1',
            signal: new AbortController().signal,
            updateMessages
        });

        const resolverSchema = mockProvider.calls[0].genConfig.responseSchema as { properties?: Record<string, unknown> };
        const narratorSchema = mockProvider.calls[1].genConfig.responseSchema as { properties?: Record<string, unknown> };
        expect(Object.keys(resolverSchema.properties ?? {})).toContain('steps');
        expect(Object.keys(narratorSchema.properties ?? {})).toContain('story');
        expect(Object.keys(narratorSchema.properties ?? {})).not.toContain('steps');
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
        const result = await engine.runTurn({
            history: [{ role: 'user', parts: [{ text: 'y' }] }],
            intent: 'action',
            outputLanguage: 'default',
            modelMsgId: 'm1',
            signal: new AbortController().signal,
            updateMessages
        });

        expect(result.turnUsage.prompt).toBe(300);
        expect(result.turnUsage.candidates).toBe(70);
        expect(result.turnUsage.cached).toBe(200);
    });
});
