import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TwoCallOrchestratorService } from './two-call-orchestrator.service';
import { TwoCallTurnEngine } from './two-call-turn-engine.service';
import { ContextBuilderService, BuildContext } from '../context-builder.service';
import { ContentParserService } from '../content-parser.service';
import { StreamProcessorService } from '../stream-processor.service';
import { GameStateService } from '../game-state.service';
import { KVStore } from '../kv/kv-store';
import { InMemoryKVStore } from '../../testing/in-memory-kv-store';
import { LLM_STORAGE_TOKEN } from '@hcs/llm-angular-common';
import type { ILLMStorage } from '@hcs/llm-core';
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
import type { ParsedStats, StatValues } from '@app/core/models/stats.types';

/** Minimal ILLMStorage stub — LLMConfigService is in the DI graph but never exercised in this spec. */
function stubLLMStorage(): ILLMStorage {
    return {
        getAll: async () => [],
        getById: async () => undefined,
        save: async () => undefined,
        delete: async () => undefined,
        subscribe: () => () => undefined,
    };
}

function step(overrides: Partial<AnalysisStep> = {}): AnalysisStep {
    return {
        kind: 'user_intent',
        source: '',
        hook_title: '',
        action: 'walk',
        pc_line: '',
        is_inner: false,
        mood: '',
        risk_factors: [],
        outcome: '成功',
        breaks_ideal: false,
        npc_reactions: [],
        object_reactions: [],
        scene_change: '',
        ...overrides
    };
}

function analysis(overrides: Partial<StructuredAnalysis> = {}): StructuredAnalysis {
    return {
        scene_snapshot: {
            date_in_world: '',
            time_hhmm: '12:00',
            location: '',
            environment: '',
            pc_name: '',
            pc_alias: '',
            pc_state: '',
            pc_awareness: '',
            present_npcs: [],
            key_objects: []
        },
        steps: [],
        ...overrides
    };
}

/**
 * Small opt-in stats fixture as a BuildContext overlay: enables the system and
 * supplies hp scalar (0-100) + affinity map + one death event with its baseline.
 */
function statsFixture(): Partial<BuildContext> {
    const statsParsed: ParsedStats = {
        stats: {
            hp: { type: 'scalar', value: 100, min: 0, max: 100 },
            affinity: { type: 'map', value: {}, min: 0, max: 100, allow_new_item: true },
        },
        rules: '',
        events: [{ condition: 'hp.value <= 0', type: 'level', trigger: '程楊宗倒下了' }],
    };
    const statsBaseline: StatValues = { hp: 100, affinity: {} };
    return { enableStatsSystem: true, statsParsed, statsBaseline };
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
                { provide: KVStore, useValue: new InMemoryKVStore() },
                { provide: LLM_STORAGE_TOKEN, useValue: stubLLMStorage() },
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
            dynamicProtocolResolver: 'RESOLVER PROTOCOL {{USER_INPUT}}',
            dynamicProtocolNarrator: 'NARRATOR PROTOCOL',
            dynamicProtocolSingle: '',
            dynamicCorrection: '',
            engineMode: 'two-call',
            enableStatsSystem: false,
            statsParsed: null,
            statsBaseline: null,
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
                    step({ action: 'speak greeting', pc_line: 'TRUNCATED-LINE-DO-NOT-LEAK' })
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

    function resolverStepProps() {
        const schema = mockProvider.calls[0].genConfig.responseSchema as {
            properties: { analysis: { properties: { steps: { items: { properties: Record<string, unknown> } } } } };
        };
        return schema.properties.analysis.properties.steps.items.properties;
    }

    it('omits stat_changes from the resolver schema when enableStatsSystem is false (opt-in off)', async () => {
        pushUser('x');
        mockProvider.enqueueJsonStream(resolverJson({ ideal_outcome: '', ideal_strength: 'pragmatic', analysis: analysis() }));
        mockProvider.enqueueJsonStream(narratorJson('s'));

        await getEngine().runTurn(runtime('x', { enableStatsSystem: false }));

        expect(resolverStepProps()).not.toHaveProperty('stat_changes');
    });

    it('threads enableStatsSystem=true through to a stat_changes resolver schema', async () => {
        pushUser('x');
        mockProvider.enqueueJsonStream(resolverJson({ ideal_outcome: '', ideal_strength: 'pragmatic', analysis: analysis() }));
        mockProvider.enqueueJsonStream(narratorJson('s'));

        await getEngine().runTurn(runtime('x', { enableStatsSystem: true }));

        expect(resolverStepProps()).toHaveProperty('stat_changes');
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

    describe('numeric-stats fold seam', () => {
        // Captures the post-turn values + triggered events the engine threads into
        // buildNarratorContext (phase 2 will render them; phase 1 only wires them).
        function spyNarratorOptions(): { current: { postStatValues?: StatValues; triggeredEvents?: string[] } } {
            const builder = TestBed.inject(ContextBuilderService);
            const captured: { current: { postStatValues?: StatValues; triggeredEvents?: string[] } } = { current: {} };
            const original = builder.buildNarratorContext.bind(builder);
            builder.buildNarratorContext = (ctx, options) => {
                captured.current = { postStatValues: options.postStatValues, triggeredEvents: options.triggeredEvents };
                return original(ctx, options);
            };
            return captured;
        }

        function enqueueStatsTurn(steps: AnalysisStep[]) {
            mockProvider.enqueueJsonStream(resolverJson({
                ideal_outcome: '', ideal_strength: 'pragmatic', analysis: analysis({ steps })
            }));
            mockProvider.enqueueJsonStream(narratorJson('s'));
        }

        it('persists thisTurnChanges (flattened truncated steps) as stat_delta', async () => {
            pushUser('attack');
            enqueueStatsTurn([
                step({ action: 'a', stat_changes: [{ key: 'hp', delta: -10 }] }),
                step({ action: 'b', stat_changes: [{ key: 'affinity', subkey: '王如花', value: 20 }] }),
            ]);

            const result = await getEngine().runTurn(runtime('attack', statsFixture()));

            expect(result.stat_delta).toEqual([
                { key: 'hp', delta: -10 },
                { key: 'affinity', subkey: '王如花', value: 20 },
            ]);
        });

        it('drops the stat_changes of steps cut by the break (raw delta = surviving steps only)', async () => {
            pushUser('attack then flee');
            enqueueStatsTurn([
                step({ action: 'a', stat_changes: [{ key: 'hp', delta: -10 }] }),
                step({ action: 'b', breaks_ideal: true, outcome: '失敗', stat_changes: [{ key: 'hp', delta: -5 }] }),
                step({ action: 'c', stat_changes: [{ key: 'hp', delta: -99 }] }),
            ]);

            const result = await getEngine().runTurn(runtime('attack then flee', statsFixture()));

            // Truncation keeps steps up to and including the breaking step.
            expect(result.stat_delta).toEqual([{ key: 'hp', delta: -10 }, { key: 'hp', delta: -5 }]);
        });

        it('folds post-turn values off baseline + full prior history, not the base context', async () => {
            // Prior committed model message carries a -30 hp delta. The fold basis is
            // the FULL captured history, so post hp = 100 - 30 (prior) - 10 (this turn).
            pushUser('start');
            messages.push({ id: 'mPrior', role: 'model', content: 's', stat_delta: [{ key: 'hp', delta: -30 }] });
            pushUser('attack');
            enqueueStatsTurn([step({ action: 'a', stat_changes: [{ key: 'hp', delta: -10 }] })]);

            const captured = spyNarratorOptions();
            await getEngine().runTurn(runtime('attack', statsFixture()));

            expect(captured.current.postStatValues?.['hp']).toBe(60);
        });

        it('a deleted mid-history model message drops its delta so post values roll back', async () => {
            // Same shape as above but the prior delta-bearing message is absent
            // (deleted / retried) — its -30 must not apply: post hp = 100 - 10.
            pushUser('attack');
            enqueueStatsTurn([step({ action: 'a', stat_changes: [{ key: 'hp', delta: -10 }] })]);

            const captured = spyNarratorOptions();
            await getEngine().runTurn(runtime('attack', statsFixture()));

            expect(captured.current.postStatValues?.['hp']).toBe(90);
        });

        it('ignores ref-only model messages in the fold basis', async () => {
            pushUser('start');
            messages.push({ id: 'mRef', role: 'model', content: 's', isRefOnly: true, stat_delta: [{ key: 'hp', delta: -40 }] });
            pushUser('attack');
            enqueueStatsTurn([step({ action: 'a', stat_changes: [{ key: 'hp', delta: -10 }] })]);

            const captured = spyNarratorOptions();
            await getEngine().runTurn(runtime('attack', statsFixture()));

            expect(captured.current.postStatValues?.['hp']).toBe(90);
        });

        it('evaluates triggered events across the pre/post value pair', async () => {
            // hp 100 -> drops to 0 this turn; the level event fires on the post value.
            pushUser('fatal blow');
            enqueueStatsTurn([step({ action: 'a', stat_changes: [{ key: 'hp', delta: -100 }] })]);

            const captured = spyNarratorOptions();
            await getEngine().runTurn(runtime('fatal blow', statsFixture()));

            expect(captured.current.postStatValues?.['hp']).toBe(0);
            expect(captured.current.triggeredEvents).toContain('程楊宗倒下了');
        });

        it('does no fold and sets no stat_delta when the stats system is off (byte-identical path)', async () => {
            pushUser('walk');
            enqueueStatsTurn([step({ action: 'a', stat_changes: [{ key: 'hp', delta: -10 }] })]);

            const captured = spyNarratorOptions();
            const result = await getEngine().runTurn(runtime('walk', { enableStatsSystem: false }));

            expect(result.stat_delta).toBeUndefined();
            expect(captured.current.postStatValues).toBeUndefined();
            expect(captured.current.triggeredEvents).toBeUndefined();
        });
    });
});
