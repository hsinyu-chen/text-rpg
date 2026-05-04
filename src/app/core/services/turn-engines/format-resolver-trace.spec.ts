import { describe, expect, it } from 'vitest';
import { formatResolverTrace } from './format-resolver-trace';
import type { ResolverOutput, ResolverStep } from '@app/core/constants/engine-protocol-two-call';

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

describe('formatResolverTrace', () => {
    it('returns empty string for empty input', () => {
        expect(formatResolverTrace({})).toBe('');
    });

    it('renders ideal outcome alone when no steps yet (mid-stream)', () => {
        const out = formatResolverTrace({ ideal_outcome: 'shake hands', ideal_strength: 'pragmatic' });
        expect(out).toContain('Ideal outcome');
        expect(out).toContain('shake hands');
        expect(out).toContain('pragmatic');
    });

    it('marks the first broken step and tags later steps as truncated', () => {
        const trace = formatResolverTrace({
            ideal_outcome: 'X',
            ideal_strength: 'pragmatic',
            steps: [
                step({ action: 'walk' }),
                step({ action: 'reach', ideal_status: 'broken', break_reason: 'NPC backed off' }),
                step({ action: 'shake' })
            ]
        } as Partial<ResolverOutput>);

        expect(trace).toContain('1. ✅ **walk**');
        expect(trace).toContain('2. 🔴 **reach**');
        expect(trace).toContain('NPC backed off');
        expect(trace).toContain('3. ⏸ **shake**');
        expect(trace).toContain('truncated after first break');
    });

    it('renders dialogue, mood, and reactions when present', () => {
        const trace = formatResolverTrace({
            steps: [step({
                action: 'greet',
                dialogue: 'hi there',
                mood: 'friendly',
                npc_reactions: [{ actor: 'farmer', reaction: 'nods', type: 'observe' }]
            })]
        });
        expect(trace).toContain('greet');
        expect(trace).toContain('"hi there"');
        expect(trace).toContain('friendly');
        expect(trace).toContain('farmer: nods');
    });

    it('skips dialogue line when dialogue is empty', () => {
        const trace = formatResolverTrace({ steps: [step({ dialogue: '' })] });
        expect(trace).not.toContain('🗣');
    });
});
