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

    it('treats target === "" as pure append (delete-via-empty-replacement is its own thing)', () => {
        const result = cFixSectionUpdates(
            [
                { sectionPath: '## A', target: '', replacement: 'x' },
                { sectionPath: '## A', replacement: 'y' },
            ],
            LABEL,
        );
        // Both are pure-append → merge.
        expect(result.updates).toEqual([
            { sectionPath: '## A', target: '', replacement: 'xy' },
        ]);
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
});
