import { describe, expect, it } from 'vitest';
import { parseTriageSelectionArgs, resolveTriageSubset } from './triage-selection-tool';

describe('parseTriageSelectionArgs', () => {
    it('parses a well-formed selection', () => {
        const out = parseTriageSelectionArgs({
            entities: [
                { name: '露娜 (Luna)', jobs: ['A', 'B'], reason: 'wounded last ACT, days passed' },
                { name: '凱爾 (Kyle)', jobs: ['B'], reason: 'off-screen plan in motion' },
            ],
        });
        expect(out.entities).toEqual([
            { name: '露娜 (Luna)', jobs: ['A', 'B'], reason: 'wounded last ACT, days passed' },
            { name: '凱爾 (Kyle)', jobs: ['B'], reason: 'off-screen plan in motion' },
        ]);
    });

    it('returns an empty selection for a non-object / missing entities', () => {
        expect(parseTriageSelectionArgs(null).entities).toEqual([]);
        expect(parseTriageSelectionArgs({}).entities).toEqual([]);
        expect(parseTriageSelectionArgs({ entities: 'nope' }).entities).toEqual([]);
    });

    it('drops entries without a string name', () => {
        const out = parseTriageSelectionArgs({
            entities: [{ jobs: ['A'], reason: 'x' }, { name: 7, reason: 'y' }, { name: 'Pete Barker', jobs: ['A'], reason: 'z' }],
        });
        expect(out.entities).toEqual([{ name: 'Pete Barker', jobs: ['A'], reason: 'z' }]);
    });

    it('filters job letters to A/B and defaults a missing reason to empty string', () => {
        const out = parseTriageSelectionArgs({
            entities: [{ name: 'Tom Stark', jobs: ['A', 'C', 'B', 99] }],
        });
        expect(out.entities).toEqual([{ name: 'Tom Stark', jobs: ['A', 'B'], reason: '' }]);
    });

    it('tolerates a non-array jobs field as an empty job list', () => {
        const out = parseTriageSelectionArgs({ entities: [{ name: 'Cara Loft', jobs: 'A', reason: 'r' }] });
        expect(out.entities).toEqual([{ name: 'Cara Loft', jobs: [], reason: 'r' }]);
    });
});

describe('resolveTriageSubset', () => {
    const roster = new Set(['露娜 (Luna)', '凱爾 (Kyle)', '王大福']);

    it('keeps only selections whose name is in the roster', () => {
        const { selected, warnings } = resolveTriageSubset(roster, {
            entities: [
                { name: '露娜 (Luna)', jobs: ['A'], reason: 'a' },
                { name: '查無此人', jobs: ['B'], reason: 'b' },
            ],
        });
        expect(selected.map(s => s.name)).toEqual(['露娜 (Luna)']);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('查無此人');
    });

    it('dedupes by name, keeping the first selection', () => {
        const { selected } = resolveTriageSubset(roster, {
            entities: [
                { name: '凱爾 (Kyle)', jobs: ['A'], reason: 'first' },
                { name: '凱爾 (Kyle)', jobs: ['B'], reason: 'second' },
            ],
        });
        expect(selected).toEqual([{ name: '凱爾 (Kyle)', jobs: ['A'], reason: 'first' }]);
    });

    it('returns an empty subset with no warnings for an empty selection', () => {
        const { selected, warnings } = resolveTriageSubset(roster, { entities: [] });
        expect(selected).toEqual([]);
        expect(warnings).toEqual([]);
    });
});
