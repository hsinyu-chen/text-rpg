import { describe, expect, it } from 'vitest';
import { applySectionUpdates } from './section-update-handlers';

const FILE = '5.科技裝備.md';
const CTX = { targetFile: FILE, fileContent: '', kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: '' } };

describe('applySectionUpdates', () => {
    it('returns empty for empty input', () => {
        expect(applySectionUpdates([], CTX)).toEqual([]);
    });

    it('emits an append hunk when target is omitted', () => {
        const updates = applySectionUpdates([
            { sectionPath: '# 已開發武器 > ## 短弓改', replacement: '* **狀態**: 完工' },
        ], CTX);
        expect(updates).toEqual([
            {
                filePath: FILE,
                context: '# 已開發武器 > ## 短弓改',
                replacementContent: '* **狀態**: 完工',
            },
        ]);
    });

    it('emits a replace hunk when target is provided', () => {
        const updates = applySectionUpdates([
            { sectionPath: '# 已開發武器 > ## 短弓改', target: '舊狀態', replacement: '新狀態' },
        ], CTX);
        expect(updates).toEqual([
            {
                filePath: FILE,
                context: '# 已開發武器 > ## 短弓改',
                targetContent: '舊狀態',
                replacementContent: '新狀態',
            },
        ]);
    });

    it('keeps multiple entries on the same sectionPath as separate hunks sharing the same context', () => {
        const updates = applySectionUpdates([
            { sectionPath: '# A > ## B', target: 'x', replacement: 'X' },
            { sectionPath: '# A > ## B', replacement: '* 附註' },
        ], CTX);
        expect(updates).toHaveLength(2);
        expect(updates.every(u => u.context === '# A > ## B')).toBe(true);
    });

    it('emits hunks for each distinct sectionPath', () => {
        const updates = applySectionUpdates([
            { sectionPath: '# A > ## B', replacement: 'x' },
            { sectionPath: '# C > ## D', replacement: 'y' },
        ], CTX);
        expect(updates.map(u => u.context)).toEqual(['# A > ## B', '# C > ## D']);
    });

    it('preserves manifest insertion order across distinct sectionPaths', () => {
        // Ordering matters for trace readability — same as the manifest the LLM
        // emitted. The grouping pass uses a Map (insertion-ordered) to keep this
        // stable rather than alphabetizing.
        const updates = applySectionUpdates([
            { sectionPath: '# Z', replacement: 'z' },
            { sectionPath: '# A', replacement: 'a' },
        ], CTX);
        expect(updates.map(u => u.context)).toEqual(['# Z', '# A']);
    });

    it('drops empty replacement on append (no point emitting a no-op)', () => {
        const updates = applySectionUpdates([
            { sectionPath: '# A', replacement: '' },
        ], CTX);
        expect(updates).toEqual([]);
    });

    it('drops degenerate empty target on replace (would match every position)', () => {
        const updates = applySectionUpdates([
            { sectionPath: '# A', target: '', replacement: 'x' },
        ], CTX);
        expect(updates).toEqual([]);
    });

    it('skips entries with no sectionPath rather than emitting a rootless hunk', () => {
        // SectionUpdate.sectionPath is required by the schema, but a buggy
        // model could still emit empty string — defend in handler too.
        const updates = applySectionUpdates([
            { sectionPath: '', replacement: 'x' },
        ], CTX);
        expect(updates).toEqual([]);
    });

    it('keeps the literal `>` in context (no entity encoding)', () => {
        // The matcher splits the context on literal `>` to derive the heading
        // breadcrumb; any entity encoding would corrupt the first segment.
        const updates = applySectionUpdates([
            { sectionPath: '# X > ## Y', replacement: 'z' },
        ], CTX);
        expect(updates[0].context).toBe('# X > ## Y');
    });
});
