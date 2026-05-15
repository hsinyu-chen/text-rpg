import { describe, expect, it } from 'vitest';
import { normalizeStep } from './normalize-structured-analysis';

describe('normalizeStep', () => {
    it('defaults a bare object to a user_intent step with empty source/hook_title', () => {
        const out = normalizeStep({});
        expect(out.kind).toBe('user_intent');
        expect(out.source).toBe('');
        expect(out.hook_title).toBe('');
    });

    it('migrates legacy kind:"random_event" to kind:"event" with source:"random"', () => {
        const out = normalizeStep({ kind: 'random_event' as unknown as 'event', action: 'NPC bursts in' });
        expect(out.kind).toBe('event');
        expect(out.source).toBe('random');
        expect(out.hook_title).toBe('');
    });

    it('preserves source:"random" on a fresh event step', () => {
        const out = normalizeStep({ kind: 'event', source: 'random', action: 'alarm rings' });
        expect(out.kind).toBe('event');
        expect(out.source).toBe('random');
        expect(out.hook_title).toBe('');
    });

    it('preserves source:"hook_fire" + hook_title on a hook event', () => {
        const out = normalizeStep({
            kind: 'event',
            source: 'hook_fire',
            hook_title: '第一次戰鬥感悟',
            action: '主角體內升起對魔力流動的本能感知'
        });
        expect(out.kind).toBe('event');
        expect(out.source).toBe('hook_fire');
        expect(out.hook_title).toBe('第一次戰鬥感悟');
    });

    it('drops hook_title when source is not hook_fire', () => {
        const out = normalizeStep({
            kind: 'event',
            source: 'random',
            hook_title: 'spurious title'
        });
        expect(out.hook_title).toBe('');
    });

    it('forces source and hook_title to "" on user_intent regardless of input', () => {
        const out = normalizeStep({
            kind: 'user_intent',
            source: 'hook_fire' as unknown as '',
            hook_title: 'leaking title' as unknown as string
        });
        expect(out.source).toBe('');
        expect(out.hook_title).toBe('');
    });

    it('coerces an unknown source value on an event step to "random"', () => {
        const out = normalizeStep({ kind: 'event', source: 'mystery' as unknown as 'random' });
        expect(out.source).toBe('random');
    });
});
