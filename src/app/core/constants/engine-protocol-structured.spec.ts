import { describe, expect, it } from 'vitest';
import {
    AnalysisStep,
    StructuredAnalysis,
    interruptedAtStep,
    isInterrupted,
    structuredAnalysisSchema,
    truncateAtBreak
} from './engine-protocol-structured';

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

function analysis(steps: AnalysisStep[]): StructuredAnalysis {
    return {
        scene_snapshot: {
            date_in_world: '',
            time_hhmm: '12:00',
            location: '',
            environment: '',
            pc_in_header: '',
            present_npcs: [],
            key_objects: []
        },
        steps,
        random_event: { triggered: false, description: '' }
    };
}

describe('isInterrupted', () => {
    it('returns false for null/undefined input', () => {
        expect(isInterrupted(null)).toBe(false);
        expect(isInterrupted(undefined)).toBe(false);
    });

    it('returns false when no step has breaks_ideal', () => {
        expect(isInterrupted(analysis([step(), step()]))).toBe(false);
    });

    it('returns true when any step has breaks_ideal=true', () => {
        expect(isInterrupted(analysis([step(), step({ breaks_ideal: true })]))).toBe(true);
    });

    it('returns false when steps is missing or not an array', () => {
        expect(isInterrupted({ steps: undefined } as unknown as StructuredAnalysis)).toBe(false);
    });
});

describe('interruptedAtStep', () => {
    it('returns 0 when no step is broken', () => {
        expect(interruptedAtStep(analysis([step(), step()]))).toBe(0);
    });

    it('returns 1-based index of the first broken step', () => {
        const a = analysis([step(), step({ breaks_ideal: true }), step({ breaks_ideal: true })]);
        expect(interruptedAtStep(a)).toBe(2);
    });

    it('returns 1 when the first step is broken', () => {
        expect(interruptedAtStep(analysis([step({ breaks_ideal: true })]))).toBe(1);
    });

    it('returns 0 for nullish input', () => {
        expect(interruptedAtStep(null)).toBe(0);
        expect(interruptedAtStep(undefined)).toBe(0);
    });
});

describe('truncateAtBreak', () => {
    it('returns input unchanged when no step is broken', () => {
        const a = analysis([step({ action: 'a' }), step({ action: 'b' })]);
        const result = truncateAtBreak(a);
        expect(result.steps).toHaveLength(2);
    });

    it('keeps the breaking step itself and drops everything after', () => {
        const a = analysis([
            step({ action: 'a' }),
            step({ action: 'b', breaks_ideal: true, outcome: '失敗' }),
            step({ action: 'c' }),
            step({ action: 'd' })
        ]);
        const result = truncateAtBreak(a);
        expect(result.steps).toHaveLength(2);
        expect(result.steps[1].action).toBe('b');
    });

    it('only honors the FIRST broken step', () => {
        const a = analysis([
            step({ action: 'a', breaks_ideal: true, outcome: '失敗 - 第一' }),
            step({ action: 'b', breaks_ideal: true, outcome: '失敗 - 第二' })
        ]);
        const result = truncateAtBreak(a);
        expect(result.steps).toHaveLength(1);
        expect(result.steps[0].outcome).toBe('失敗 - 第一');
    });

    it('does not mutate the input', () => {
        const a = analysis([step({ action: 'a' }), step({ action: 'b', breaks_ideal: true }), step({ action: 'c' })]);
        const before = a.steps.length;
        truncateAtBreak(a);
        expect(a.steps).toHaveLength(before);
    });

    it('preserves scene_snapshot and random_event', () => {
        const a: StructuredAnalysis = {
            scene_snapshot: {
                date_in_world: '聖曆 1000年04月02日 週二',
                time_hhmm: '13:00',
                location: '森林',
                environment: '雨',
                pc_in_header: '程楊宗',
                present_npcs: [{ name: '梨菲', state: '匿蹤' }],
                key_objects: []
            },
            steps: [step({ action: 'a', breaks_ideal: true }), step({ action: 'b' })],
            random_event: { triggered: true, description: '雷劈' }
        };
        const result = truncateAtBreak(a);
        expect(result.scene_snapshot).toEqual(a.scene_snapshot);
        expect(result.random_event).toEqual(a.random_event);
    });
});

describe('structuredAnalysisSchema', () => {
    it('declares all required top-level fields', () => {
        const schema = structuredAnalysisSchema as { required?: string[] };
        expect(schema.required).toEqual(expect.arrayContaining(['scene_snapshot', 'steps', 'random_event']));
    });

    it('step schema requires breaks_ideal as boolean and lists scene reactions as required', () => {
        const schema = structuredAnalysisSchema as {
            properties: {
                steps: { items: { required?: string[]; properties: Record<string, { type?: string }> } };
            };
        };
        const stepReq = schema.properties.steps.items.required ?? [];
        expect(stepReq).toEqual(expect.arrayContaining([
            'action', 'pc_dialogue', 'mood', 'risk_factors', 'outcome', 'breaks_ideal',
            'npc_reactions', 'object_reactions'
        ]));
        expect(schema.properties.steps.items.properties['breaks_ideal'].type).toBe('boolean');
    });

    it('npc_reaction schema includes a verbatim dialogue field (the bug-fix this redesign targets)', () => {
        const schema = structuredAnalysisSchema as {
            properties: {
                steps: {
                    items: {
                        properties: {
                            npc_reactions: { items: { required?: string[]; properties: Record<string, unknown> } };
                        };
                    };
                };
            };
        };
        const npcSchema = schema.properties.steps.items.properties.npc_reactions.items;
        expect(npcSchema.required).toEqual(expect.arrayContaining(['actor', 'physical', 'dialogue', 'motivation']));
    });

    it('object_reaction schema requires both name and change', () => {
        const schema = structuredAnalysisSchema as {
            properties: {
                steps: {
                    items: {
                        properties: {
                            object_reactions: { items: { required?: string[] } };
                        };
                    };
                };
            };
        };
        const objSchema = schema.properties.steps.items.properties.object_reactions.items;
        expect(objSchema.required).toEqual(expect.arrayContaining(['name', 'change']));
    });

    it('scene_snapshot schema enumerates time_hhmm, environment, present_npcs, key_objects', () => {
        const schema = structuredAnalysisSchema as {
            properties: { scene_snapshot: { required?: string[] } };
        };
        expect(schema.properties.scene_snapshot.required).toEqual(
            expect.arrayContaining(['time_hhmm', 'environment', 'present_npcs', 'key_objects'])
        );
    });
});
