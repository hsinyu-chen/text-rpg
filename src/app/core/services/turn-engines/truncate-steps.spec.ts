import { describe, expect, it } from 'vitest';
import { truncateAtFirstBroken } from './truncate-steps';
import type { ResolverStep } from '@app/core/constants/engine-protocol-two-call';

function step(overrides: Partial<ResolverStep> = {}): ResolverStep {
    return {
        action: 'walk',
        action_type: 'movement',
        target: '',
        dialogue: '',
        mood: 'calm',
        state_changes: [],
        event_type: 'ambient',
        ideal_status: 'intact',
        break_reason: '',
        npc_reactions: [],
        ambient: '',
        ...overrides
    };
}

describe('truncateAtFirstBroken', () => {
    it('returns empty result for an empty array', () => {
        expect(truncateAtFirstBroken([])).toEqual({
            executed: [],
            interruptedAtStep: 0,
            interrupted: false
        });
    });

    it('keeps every step when all are intact', () => {
        const steps = [step({ action: 'a' }), step({ action: 'b' }), step({ action: 'c' })];
        const result = truncateAtFirstBroken(steps);
        expect(result.executed).toHaveLength(3);
        expect(result.interrupted).toBe(false);
        expect(result.interruptedAtStep).toBe(0);
    });

    it('truncates at the first broken step (broken step itself is included)', () => {
        const steps = [
            step({ action: 'walk' }),
            step({ action: 'reach', ideal_status: 'broken', break_reason: 'NPC stepped back' }),
            step({ action: 'shake' }),
            step({ action: 'speak', dialogue: 'should be dropped' })
        ];
        const result = truncateAtFirstBroken(steps);
        expect(result.executed).toHaveLength(2);
        expect(result.executed[1].action).toBe('reach');
        expect(result.executed[1].break_reason).toBe('NPC stepped back');
        expect(result.interrupted).toBe(true);
        expect(result.interruptedAtStep).toBe(2);
    });

    it('truncates immediately when the first step itself is broken', () => {
        const steps = [
            step({ action: 'cast', ideal_status: 'broken', break_reason: 'no mana' }),
            step({ action: 'follow up' })
        ];
        const result = truncateAtFirstBroken(steps);
        expect(result.executed).toEqual([steps[0]]);
        expect(result.interruptedAtStep).toBe(1);
        expect(result.interrupted).toBe(true);
    });

    it('returns single broken step intact when array length is 1', () => {
        const steps = [step({ ideal_status: 'broken', break_reason: 'cannot' })];
        const result = truncateAtFirstBroken(steps);
        expect(result.executed).toHaveLength(1);
        expect(result.interrupted).toBe(true);
        expect(result.interruptedAtStep).toBe(1);
    });

    it('only honors the FIRST broken step (later broken steps in input are ignored)', () => {
        const steps = [
            step({ action: 'a' }),
            step({ action: 'b', ideal_status: 'broken', break_reason: 'first' }),
            step({ action: 'c', ideal_status: 'broken', break_reason: 'should not surface' })
        ];
        const result = truncateAtFirstBroken(steps);
        expect(result.executed).toHaveLength(2);
        expect(result.interruptedAtStep).toBe(2);
        expect(result.executed[1].break_reason).toBe('first');
    });

    it('does not mutate the input array', () => {
        const steps = [step({ action: 'a' }), step({ action: 'b', ideal_status: 'broken' }), step({ action: 'c' })];
        const snapshot = steps.slice();
        truncateAtFirstBroken(steps);
        expect(steps).toEqual(snapshot);
    });
});
