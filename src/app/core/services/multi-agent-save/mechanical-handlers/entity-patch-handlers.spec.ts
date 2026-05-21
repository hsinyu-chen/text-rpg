import { describe, expect, it } from 'vitest';
import { applyEntityPatches } from './entity-patch-handlers';

const FILE = '3.人物狀態.md';
const ctxFor = (fileContent = '') => ({
    targetFile: FILE,
    fileContent,
    kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: '' },
});

describe('applyEntityPatches', () => {
    it('returns empty for empty input', () => {
        expect(applyEntityPatches([], ctxFor())).toEqual([]);
    });

    it('returns empty when no entry carries `updates` (multi-call routing case)', () => {
        const updates = applyEntityPatches(
            [{ name: '李四', reasonHint: 'after war' }, { name: '王五' }],
            ctxFor(),
        );
        expect(updates).toEqual([]);
    });

    it('flattens updates across entries and emits hunks per sectionPath', () => {
        const updates = applyEntityPatches([
            {
                name: '李四',
                updates: [
                    { sectionPath: '# 核心人物 > ## 李四', target: '舊心態', replacement: '新心態' },
                ],
            },
            {
                name: '王五',
                updates: [
                    { sectionPath: '# 核心人物 > ## 王五', replacement: '\n- 新增筆記' },
                ],
            },
        ], ctxFor());
        expect(updates).toHaveLength(2);
        expect(updates[0]).toEqual({
            filePath: FILE,
            context: '# 核心人物 > ## 李四',
            targetContent: '舊心態',
            replacementContent: '新心態',
        });
        expect(updates[1]).toEqual({
            filePath: FILE,
            context: '# 核心人物 > ## 王五',
            replacementContent: '\n- 新增筆記',
        });
    });

    it('emits multiple updates targeting the same sectionPath as separate hunks sharing context', () => {
        const updates = applyEntityPatches([
            {
                name: '李四',
                updates: [
                    { sectionPath: '# 核心人物 > ## 李四', target: '舊一', replacement: '新一' },
                    { sectionPath: '# 核心人物 > ## 李四', target: '舊二', replacement: '新二' },
                ],
            },
        ], ctxFor());
        expect(updates).toHaveLength(2);
        expect(updates.every(u => u.context === '# 核心人物 > ## 李四')).toBe(true);
    });

    it('drops degenerate ops (empty append) and keeps the rest', () => {
        // Mirrors applySectionUpdates' drop rules: append with empty replacement
        // is a no-op and gets dropped at the handler boundary.
        const updates = applyEntityPatches([
            {
                name: '李四',
                updates: [
                    { sectionPath: '# 核心人物 > ## 李四', replacement: '' },
                    { sectionPath: '# 核心人物 > ## 李四', target: '舊', replacement: '新' },
                ],
            },
        ], ctxFor());
        expect(updates).toHaveLength(1);
        expect(updates[0].targetContent).toBe('舊');
        expect(updates[0].replacementContent).toBe('新');
    });

    it('handles a mix of multi-call (no updates) and 1-call (with updates) entries', () => {
        // In transition / edge scenarios the manifest could carry both; the
        // handler simply ignores the multi-call entry and emits hunks for the
        // 1-call one. (Phase B routing decides what to do with the multi-call
        // entry; that's the dispatcher's concern, not this handler's.)
        const updates = applyEntityPatches([
            { name: '李四', reasonHint: 'sub-agent will handle' },
            {
                name: '王五',
                updates: [
                    { sectionPath: '# 核心人物 > ## 王五', replacement: '\n- 新增' },
                ],
            },
        ], ctxFor());
        expect(updates).toHaveLength(1);
        expect(updates[0].context).toBe('# 核心人物 > ## 王五');
    });
});
