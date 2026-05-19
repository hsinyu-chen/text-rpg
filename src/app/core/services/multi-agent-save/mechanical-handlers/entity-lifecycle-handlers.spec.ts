import { describe, expect, it } from 'vitest';
import { createEntities, deleteEntities, moveEntities } from './entity-lifecycle-handlers';

const FILE = '3.人物狀態.md';

describe('createEntities', () => {
    it('returns empty for empty input', () => {
        expect(createEntities([], { targetFile: FILE, fileContent: '', kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } })).toBe('');
    });

    it('emits one append op per entity under the L1 group context', () => {
        const xml = createEntities([
            { name: '李四', group: '核心人物', draftedFields: { '身分': '劍士', '基本設定': '人族 / 男 / 25 / 守序善良' } },
        ], { targetFile: FILE, fileContent: '', kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        expect(xml).toContain(`<save file="${FILE}" context="# 核心人物">`);
        expect(xml).toContain('## 李四');
        expect(xml).toContain('- **身分**: 劍士');
        expect(xml).toContain('- **基本設定**: 人族 / 男 / 25 / 守序善良');
        expect(xml).not.toContain('<target>');
    });

    it('groups same-L1-group creates into one <save> block', () => {
        const xml = createEntities([
            { name: '李四', group: '核心人物', draftedFields: { f: 'v' } },
            { name: '王五', group: '核心人物', draftedFields: { f: 'v' } },
        ], { targetFile: FILE, fileContent: '', kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        expect(xml.match(/<save\b/g)).toHaveLength(1);
        expect(xml.match(/<update>/g)).toHaveLength(2);
    });

    it('emits distinct <save> blocks for distinct L1 groups', () => {
        const xml = createEntities([
            { name: '李四', group: '核心人物', draftedFields: { f: 'v' } },
            { name: '某甲', group: '次要人物', draftedFields: { f: 'v' } },
        ], { targetFile: FILE, fileContent: '', kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        expect(xml.match(/<save\b/g)).toHaveLength(2);
        expect(xml).toContain('context="# 核心人物"');
        expect(xml).toContain('context="# 次要人物"');
    });

    it('drops entities with no draftedFields (heading-only body would be useless)', () => {
        const xml = createEntities([
            { name: '李四', group: '核心人物', draftedFields: {} },
        ], { targetFile: FILE, fileContent: '', kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        expect(xml).toBe('');
    });

    it('drops entities missing name or group rather than emitting a broken context', () => {
        const xml = createEntities([
            { name: '', group: '核心人物', draftedFields: { f: 'v' } },
            { name: '李四', group: '', draftedFields: { f: 'v' } },
        ], { targetFile: FILE, fileContent: '', kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        expect(xml).toBe('');
    });
});

describe('deleteEntities', () => {
    const FILE_WITH_BODY = `# 核心人物

## 李四

- **身分**: 劍士
- **最後已知位置**: 城門

## 王五

- **身分**: 法師

# 次要人物

## 某甲

- **身分**: 商人
`;

    it('returns empty for empty input', () => {
        expect(deleteEntities([], { targetFile: FILE, fileContent: '', kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } })).toBe('');
    });

    it('emits a delete op containing the full L2 block when entity is found', () => {
        const xml = deleteEntities([
            { name: '王五', reason: '已故' },
        ], { targetFile: FILE, fileContent: FILE_WITH_BODY, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        expect(xml).toContain('<target>');
        expect(xml).toContain('## 王五');
        expect(xml).toContain('- **身分**: 法師');
        // Should NOT include the sibling's content.
        expect(xml).not.toContain('李四');
        expect(xml).not.toContain('某甲');
    });

    it('drops the entry silently when entity not found', () => {
        const xml = deleteEntities([
            { name: '不存在的人', reason: 'x' },
        ], { targetFile: FILE, fileContent: FILE_WITH_BODY, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        expect(xml).toBe('');
    });

    it('groups multiple deletes into one root-context <save> block', () => {
        const xml = deleteEntities([
            { name: '李四', reason: 'a' },
            { name: '王五', reason: 'b' },
        ], { targetFile: FILE, fileContent: FILE_WITH_BODY, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        expect(xml.match(/<save\b/g)).toHaveLength(1);
        expect(xml.match(/<update>/g)).toHaveLength(2);
        expect(xml).toContain(`<save file="${FILE}" context="">`);
    });

    it('does NOT include the `reason` field in the emitted XML (trace-only)', () => {
        const xml = deleteEntities([
            { name: '王五', reason: '在第三章被反派擊殺' },
        ], { targetFile: FILE, fileContent: FILE_WITH_BODY, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        expect(xml).not.toContain('在第三章');
        expect(xml).not.toContain('reason');
    });
});

describe('moveEntities', () => {
    const FILE_WITH_BODY = `# 核心人物

## 李四

- **身分**: 劍士

# 已故人物

`;

    it('returns empty for empty input', () => {
        expect(moveEntities([], { targetFile: FILE, fileContent: '', kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } })).toBe('');
    });

    it('emits a delete from the source + append under the target group', () => {
        const xml = moveEntities([
            { name: '李四', toGroup: '已故人物', reason: '劇情死亡' },
        ], { targetFile: FILE, fileContent: FILE_WITH_BODY, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        // Two save blocks: one root-context delete + one target-group append.
        expect(xml.match(/<save\b/g)).toHaveLength(2);
        expect(xml).toContain(`<save file="${FILE}" context="">`);
        expect(xml).toContain('context="# 已故人物"');
        // The full block text appears in BOTH ops (target of delete + replacement of append).
        const blockCount = (xml.match(/## 李四/g) ?? []).length;
        expect(blockCount).toBe(2);
    });

    it('drops the move when entity is not found in the file', () => {
        const xml = moveEntities([
            { name: '不存在', toGroup: '已故人物', reason: 'x' },
        ], { targetFile: FILE, fileContent: FILE_WITH_BODY, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        expect(xml).toBe('');
    });

    it('groups same-target-group moves into one append <save>', () => {
        const fileContent = `# 核心人物

## 李四

- **身分**: 劍士

## 王五

- **身分**: 法師

# 已故人物

`;
        const xml = moveEntities([
            { name: '李四', toGroup: '已故人物', reason: 'a' },
            { name: '王五', toGroup: '已故人物', reason: 'b' },
        ], { targetFile: FILE, fileContent, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } });
        // 1 delete <save> (both targets) + 1 append <save> (both replacements).
        expect(xml.match(/<save\b/g)).toHaveLength(2);
        expect((xml.match(/<update>/g) ?? []).length).toBe(4);
    });
});
