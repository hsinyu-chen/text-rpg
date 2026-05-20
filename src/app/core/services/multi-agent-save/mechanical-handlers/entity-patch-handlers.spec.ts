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
        expect(applyEntityPatches([], ctxFor())).toBe('');
    });

    it('returns empty when no entry carries `updates` (multi-call routing case)', () => {
        const xml = applyEntityPatches(
            [{ name: '李四', reasonHint: 'after war' }, { name: '王五' }],
            ctxFor(),
        );
        expect(xml).toBe('');
    });

    it('flattens updates across entries and emits one <save> per sectionPath', () => {
        const xml = applyEntityPatches([
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
        expect(xml.match(/<save\b/g)).toHaveLength(2);
        expect(xml).toContain('context="# 核心人物 > ## 李四"');
        expect(xml).toContain('context="# 核心人物 > ## 王五"');
        expect(xml).toContain('新心態');
        expect(xml).toContain('新增筆記');
    });

    it('groups multiple updates targeting the same sectionPath into one <save>', () => {
        const xml = applyEntityPatches([
            {
                name: '李四',
                updates: [
                    { sectionPath: '# 核心人物 > ## 李四', target: '舊一', replacement: '新一' },
                    { sectionPath: '# 核心人物 > ## 李四', target: '舊二', replacement: '新二' },
                ],
            },
        ], ctxFor());
        expect(xml.match(/<save\b/g)).toHaveLength(1);
        expect(xml.match(/<update>/g)).toHaveLength(2);
    });

    it('drops degenerate ops (empty append) and keeps the rest', () => {
        // Mirrors applySectionUpdates' drop rules: append with empty replacement
        // is a no-op and gets dropped at the handler boundary.
        const xml = applyEntityPatches([
            {
                name: '李四',
                updates: [
                    { sectionPath: '# 核心人物 > ## 李四', replacement: '' },
                    { sectionPath: '# 核心人物 > ## 李四', target: '舊', replacement: '新' },
                ],
            },
        ], ctxFor());
        expect(xml.match(/<update>/g)).toHaveLength(1);
        expect(xml).toContain('新');
    });

    it('handles a mix of multi-call (no updates) and 1-call (with updates) entries', () => {
        // In transition / edge scenarios the manifest could carry both; the
        // handler simply ignores the multi-call entry and emits XML for the
        // 1-call one. (Phase B routing decides what to do with the multi-call
        // entry; that's the dispatcher's concern, not this handler's.)
        const xml = applyEntityPatches([
            { name: '李四', reasonHint: 'sub-agent will handle' },
            {
                name: '王五',
                updates: [
                    { sectionPath: '# 核心人物 > ## 王五', replacement: '\n- 新增' },
                ],
            },
        ], ctxFor());
        expect(xml.match(/<save\b/g)).toHaveLength(1);
        expect(xml).toContain('## 王五');
        expect(xml).not.toContain('李四');
    });
});
