import { describe, expect, it } from 'vitest';
import { dedupeLastWins, unionSourceMessageIds } from './handler-helpers.util';

describe('unionSourceMessageIds', () => {
    it('returns undefined when both inputs are undefined', () => {
        expect(unionSourceMessageIds(undefined, undefined)).toBeUndefined();
    });

    it('returns undefined when both inputs are empty arrays', () => {
        // The OpEvidence convention treats omitted and `[]` the same — neither
        // contributes anchors. Returning undefined lets the caller's spread
        // skip materializing the field on the output object.
        expect(unionSourceMessageIds([], [])).toBeUndefined();
    });

    it('preserves single-side ids when other is undefined', () => {
        expect(unionSourceMessageIds(['m1', 'm2'], undefined)).toEqual(['m1', 'm2']);
        expect(unionSourceMessageIds(undefined, ['m1', 'm2'])).toEqual(['m1', 'm2']);
    });

    it('unions disjoint sides, order-preserving (a first, b appended)', () => {
        expect(unionSourceMessageIds(['m1', 'm2'], ['m3', 'm4']))
            .toEqual(['m1', 'm2', 'm3', 'm4']);
    });

    it('dedupes overlap (b items already in a are skipped)', () => {
        expect(unionSourceMessageIds(['m1', 'm2'], ['m2', 'm3']))
            .toEqual(['m1', 'm2', 'm3']);
    });

    it('dedupes within a side too (defensive)', () => {
        // Set-based dedup catches accidentally-duplicated ids on either side.
        expect(unionSourceMessageIds(['m1', 'm1', 'm2'], ['m2', 'm3']))
            .toEqual(['m1', 'm2', 'm3']);
    });
});

describe('dedupeLastWins', () => {
    it('returns a copy when 0 or 1 items (no work to do)', () => {
        expect(dedupeLastWins([], x => String(x), () => { /* no-op */ })).toEqual([]);
        expect(dedupeLastWins([1], x => String(x), () => { /* no-op */ })).toEqual([1]);
    });

    it('keeps the last occurrence of each key, drops earlier ones', () => {
        const dropped: number[] = [];
        const out = dedupeLastWins(
            [
                { k: 'a', v: 1 },
                { k: 'b', v: 2 },
                { k: 'a', v: 3 },
            ],
            x => x.k,
            x => dropped.push(x.v),
        );
        expect(out).toEqual([{ k: 'b', v: 2 }, { k: 'a', v: 3 }]);
        expect(dropped).toEqual([1]);
    });

    it('passes through unique keys untouched', () => {
        const out = dedupeLastWins([{ k: 'a' }, { k: 'b' }], x => x.k, () => { /* no-op */ });
        expect(out).toEqual([{ k: 'a' }, { k: 'b' }]);
    });
});
