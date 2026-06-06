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
        const out = normalizeStep({ kind: 'random_event', action: 'NPC bursts in' });
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

    it('preserves source:"skill_item" on a fresh event step', () => {
        const out = normalizeStep({ kind: 'event', source: 'skill_item', action: '護身符受魔力共鳴而發熱示警' });
        expect(out.kind).toBe('event');
        expect(out.source).toBe('skill_item');
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
            source: 'hook_fire',
            hook_title: 'leaking title'
        });
        expect(out.source).toBe('');
        expect(out.hook_title).toBe('');
    });

    it('coerces an unknown source value on an event step to "random"', () => {
        const out = normalizeStep({ kind: 'event', source: 'mystery' });
        expect(out.source).toBe('random');
    });

    describe('stat_changes', () => {
        it('omits the field entirely for a legacy step with no stat_changes', () => {
            const out = normalizeStep({ action: 'walk' });
            expect(out).not.toHaveProperty('stat_changes');
        });

        it('omits the field when stat_changes is present but not an array', () => {
            const out = normalizeStep({ stat_changes: 'oops' } as unknown as Parameters<typeof normalizeStep>[0]);
            expect(out).not.toHaveProperty('stat_changes');
        });

        it('parses valid stat_changes, preserving subkey / delta / value / reason', () => {
            const out = normalizeStep({
                stat_changes: [
                    { key: 'hp', delta: -5, reason: 'took a hit' },
                    { key: 'inventory', subkey: 'gold', value: 100 }
                ]
            } as unknown as Parameters<typeof normalizeStep>[0]);
            expect(out.stat_changes).toEqual([
                { key: 'hp', delta: -5, reason: 'took a hit' },
                { key: 'inventory', subkey: 'gold', value: 100 }
            ]);
        });

        it('drops entries with an invalid / non-string / empty key', () => {
            const out = normalizeStep({
                stat_changes: [
                    { key: 'hp', delta: 1 },
                    { key: '' },
                    { key: 'has space', delta: 1 },
                    { key: 42 },
                    { delta: 1 },
                    'not-an-object'
                ]
            } as unknown as Parameters<typeof normalizeStep>[0]);
            expect(out.stat_changes).toEqual([{ key: 'hp', delta: 1 }]);
        });

        it('drops non-numeric delta / value fields but keeps the entry on a valid key', () => {
            const out = normalizeStep({
                stat_changes: [
                    { key: 'hp', delta: 'lots', value: NaN, subkey: 5, reason: 99 }
                ]
            } as unknown as Parameters<typeof normalizeStep>[0]);
            expect(out.stat_changes).toEqual([{ key: 'hp' }]);
        });

        it('yields an empty array (not absent) when stat_changes is an empty array', () => {
            const out = normalizeStep({ stat_changes: [] } as unknown as Parameters<typeof normalizeStep>[0]);
            expect(out.stat_changes).toEqual([]);
        });

        it('drops an empty / whitespace subkey (a scalar change, not a malformed map one)', () => {
            const out = normalizeStep({
                stat_changes: [
                    { key: 'mp', delta: -1, subkey: '' },
                    { key: 'mp', delta: -1, subkey: '   ' },
                    { key: 'affinity', subkey: '王大福', value: 10 },
                ]
            } as unknown as Parameters<typeof normalizeStep>[0]);
            expect(out.stat_changes).toEqual([
                { key: 'mp', delta: -1 },
                { key: 'mp', delta: -1 },
                { key: 'affinity', subkey: '王大福', value: 10 },
            ]);
        });

        it('trims a padded subkey so whitespace cannot fork a map key', () => {
            const out = normalizeStep({
                stat_changes: [
                    { key: 'affinity', subkey: ' 王大福 ', value: 10 },
                ]
            } as unknown as Parameters<typeof normalizeStep>[0]);
            expect(out.stat_changes).toEqual([
                { key: 'affinity', subkey: '王大福', value: 10 },
            ]);
        });

        it('keeps field only when it is a bound ("min"/"max"); drops "value" and invalid', () => {
            const out = normalizeStep({
                stat_changes: [
                    { key: 'hp', field: 'max', delta: 50 },
                    { key: 'hp', field: 'min', value: 10 },
                    { key: 'hp', field: 'value', delta: -5 },
                    { key: 'hp', field: 'bogus', delta: 1 },
                ]
            } as unknown as Parameters<typeof normalizeStep>[0]);
            expect(out.stat_changes).toEqual([
                { key: 'hp', field: 'max', delta: 50 },
                { key: 'hp', field: 'min', value: 10 },
                { key: 'hp', delta: -5 },
                { key: 'hp', delta: 1 },
            ]);
        });
    });
});
