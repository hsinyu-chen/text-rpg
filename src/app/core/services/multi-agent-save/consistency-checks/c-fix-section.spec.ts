import { describe, expect, it } from 'vitest';
import type { SectionUpdate } from '../multi-agent-save.types';
import { cFixSectionUpdates } from './c-fix-section';

const LABEL = 'techEquipmentUpdates';

describe('cFixSectionUpdates', () => {
    it('returns empty for empty input', () => {
        expect(cFixSectionUpdates([], LABEL)).toEqual({ updates: [], fixes: [] });
    });

    it('passes clean updates through unchanged', () => {
        const updates: SectionUpdate[] = [
            { sectionPath: '## 玄鐵令', replacement: '\n- 新性質' },
            { sectionPath: '## 子午鴛鴦鉞', target: '舊', replacement: '新' },
        ];
        const result = cFixSectionUpdates(updates, LABEL);
        expect(result.updates).toEqual(updates);
        expect(result.fixes).toEqual([]);
    });

    it('merges two pure appends with the same sectionPath into one', () => {
        const result = cFixSectionUpdates(
            [
                { sectionPath: '## 玄鐵令', replacement: '\n- 性質 A' },
                { sectionPath: '## 玄鐵令', replacement: '\n- 性質 B' },
            ],
            LABEL,
        );
        expect(result.updates).toEqual([
            { sectionPath: '## 玄鐵令', replacement: '\n- 性質 A\n- 性質 B' },
        ]);
        expect(result.fixes).toHaveLength(1);
        expect(result.fixes[0]).toMatchObject({
            domain: 'section',
            kind: 'merged-dup-appends',
        });
    });

    it('merges three appends and preserves order of unrelated updates', () => {
        const result = cFixSectionUpdates(
            [
                { sectionPath: '## A', replacement: 'a1' },
                { sectionPath: '## B', replacement: 'b1' },
                { sectionPath: '## A', replacement: 'a2' },
                { sectionPath: '## A', replacement: 'a3' },
            ],
            LABEL,
        );
        expect(result.updates).toEqual([
            { sectionPath: '## A', replacement: 'a1a2a3' },
            { sectionPath: '## B', replacement: 'b1' },
        ]);
        // Two merges (a2 + a3 → into a1).
        expect(result.fixes.filter(f => f.kind === 'merged-dup-appends')).toHaveLength(2);
    });

    it('does NOT merge targeted updates (different ops cannot collapse)', () => {
        const updates: SectionUpdate[] = [
            { sectionPath: '## 玄鐵令', target: 'A', replacement: 'B' },
            { sectionPath: '## 玄鐵令', target: 'C', replacement: 'D' },
        ];
        const result = cFixSectionUpdates(updates, LABEL);
        expect(result.updates).toEqual(updates);
        expect(result.fixes).toEqual([]);
    });

    it('only merges pure appends when mixed with targeted updates', () => {
        const result = cFixSectionUpdates(
            [
                { sectionPath: '## 玄鐵令', target: '舊', replacement: '新' },
                { sectionPath: '## 玄鐵令', replacement: '\n- 加一條' },
                { sectionPath: '## 玄鐵令', replacement: '\n- 加另一條' },
            ],
            LABEL,
        );
        expect(result.updates).toEqual([
            { sectionPath: '## 玄鐵令', target: '舊', replacement: '新' },
            { sectionPath: '## 玄鐵令', replacement: '\n- 加一條\n- 加另一條' },
        ]);
        expect(result.fixes).toHaveLength(1);
    });

    it('drops target === "" as degenerate (handler refuses; merging would eat the sibling)', () => {
        // Regression: prior implementation treated target==='' as
        // pure-append and merged it with the sibling, but the resulting
        // entry still carried target:'' and got dropped wholesale by the
        // handler — losing BOTH replacements. The fix drops the empty-
        // target entry up front; the sibling pure-append survives.
        const result = cFixSectionUpdates(
            [
                { sectionPath: '## A', target: '', replacement: 'x' },
                { sectionPath: '## A', replacement: 'y' },
            ],
            LABEL,
        );
        expect(result.updates).toEqual([
            { sectionPath: '## A', replacement: 'y' },
        ]);
        expect(result.fixes.some(f => f.kind === 'dropped-empty-target')).toBe(true);
    });

    it('drops lone target === "" with no sibling', () => {
        const result = cFixSectionUpdates(
            [{ sectionPath: '## A', target: '', replacement: 'x' }],
            LABEL,
        );
        expect(result.updates).toEqual([]);
        expect(result.fixes[0]).toMatchObject({ kind: 'dropped-empty-target' });
    });

    it('drops update with empty sectionPath', () => {
        const result = cFixSectionUpdates(
            [{ sectionPath: '', replacement: 'x' }],
            LABEL,
        );
        expect(result.updates).toEqual([]);
        expect(result.fixes[0]).toMatchObject({ kind: 'dropped-empty-sectionPath' });
        expect(result.fixes[0].reason).toContain(LABEL);
    });

    describe('sourceMessageIds preservation through merge', () => {
        it('unions ids when two pure-append updates merge', () => {
            const result = cFixSectionUpdates(
                [
                    { sectionPath: '## X', replacement: 'a', sourceMessageIds: ['m1', 'm2'] },
                    { sectionPath: '## X', replacement: 'b', sourceMessageIds: ['m2', 'm3'] },
                ],
                LABEL,
            );
            expect(result.updates).toEqual([
                {
                    sectionPath: '## X',
                    replacement: 'ab',
                    sourceMessageIds: ['m1', 'm2', 'm3'],
                },
            ]);
        });

        it('preserves single side ids when only one update carries them', () => {
            const result = cFixSectionUpdates(
                [
                    { sectionPath: '## X', replacement: 'a', sourceMessageIds: ['m1'] },
                    { sectionPath: '## X', replacement: 'b' },
                ],
                LABEL,
            );
            expect(result.updates[0].sourceMessageIds).toEqual(['m1']);
        });

        it('omits the field on merged output when neither input carried ids', () => {
            const result = cFixSectionUpdates(
                [
                    { sectionPath: '## X', replacement: 'a' },
                    { sectionPath: '## X', replacement: 'b' },
                ],
                LABEL,
            );
            // Strict-omitted: avoids materializing `sourceMessageIds: []` /
            // `: undefined` on the output object so downstream presence
            // checks still see "no anchors emitted".
            expect('sourceMessageIds' in result.updates[0]).toBe(false);
        });
    });
});
