import { describe, expect, it } from 'vitest';
import { createEntities, deleteEntities, moveEntities } from './entity-lifecycle-handlers';

const FILE = '3.人物狀態.md';
const ctxFor = (fileContent: string) => ({
    targetFile: FILE,
    fileContent,
    kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: '' },
});

describe('createEntities', () => {
    it('returns empty for empty input', () => {
        expect(createEntities([], ctxFor(''))).toBe('');
    });

    it('emits one append op per entity under the L1 group context', () => {
        const xml = createEntities([
            { name: '李四', group: '核心人物', draftedFields: { '身分': '劍士', '基本設定': '人族 / 男 / 25 / 守序善良' } },
        ], ctxFor(''));
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
        ], ctxFor(''));
        expect(xml.match(/<save\b/g)).toHaveLength(1);
        expect(xml.match(/<update>/g)).toHaveLength(2);
    });

    it('emits distinct <save> blocks for distinct L1 groups', () => {
        const xml = createEntities([
            { name: '李四', group: '核心人物', draftedFields: { f: 'v' } },
            { name: '某甲', group: '次要人物', draftedFields: { f: 'v' } },
        ], ctxFor(''));
        expect(xml.match(/<save\b/g)).toHaveLength(2);
        expect(xml).toContain('context="# 核心人物"');
        expect(xml).toContain('context="# 次要人物"');
    });

    it('drops entities with no draftedFields (heading-only body would be useless)', () => {
        const xml = createEntities([
            { name: '李四', group: '核心人物', draftedFields: {} },
        ], ctxFor(''));
        expect(xml).toBe('');
    });

    it('drops entities missing name or group rather than emitting a broken context', () => {
        const xml = createEntities([
            { name: '', group: '核心人物', draftedFields: { f: 'v' } },
            { name: '李四', group: '', draftedFields: { f: 'v' } },
        ], ctxFor(''));
        expect(xml).toBe('');
    });

    it('strips any leading `#` prefix the model put on `group` or `name` (defensive)', () => {
        // Schema says these are bare text, but local models drift. Without the
        // strip we would emit `context="# # 核心人物"` and `## ## 李四` — both
        // silently break the heading-path lookup.
        const bare = createEntities([
            { name: '李四', group: '核心人物', draftedFields: { f: 'v' } },
        ], ctxFor(''));
        const prefixed = createEntities([
            { name: '## 李四', group: '# 核心人物', draftedFields: { f: 'v' } },
        ], ctxFor(''));
        expect(prefixed).toBe(bare);
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
        expect(deleteEntities([], ctxFor(''))).toBe('');
    });

    it('emits a delete op containing the full L2 block when entity is found', () => {
        const xml = deleteEntities([
            { sectionPath: '# 核心人物 > ## 王五', reason: '已故' },
        ], ctxFor(FILE_WITH_BODY));
        expect(xml).toContain('<target>');
        expect(xml).toContain('## 王五');
        expect(xml).toContain('- **身分**: 法師');
        // Should NOT include the sibling's content.
        expect(xml).not.toContain('李四');
        expect(xml).not.toContain('某甲');
    });

    it('drops the entry silently when sectionPath does not resolve', () => {
        const xml = deleteEntities([
            { sectionPath: '# 核心人物 > ## 不存在的人', reason: 'x' },
        ], ctxFor(FILE_WITH_BODY));
        expect(xml).toBe('');
    });

    it('disambiguates same-name entities across L1 groups by the full breadcrumb', () => {
        // Same `## 王五` heading would exist under both `# 核心人物` and
        // `# 次要人物` if the file had it; the breadcrumb resolves to exactly
        // one match instead of silently bailing on ambiguity.
        const FILE_WITH_DUPES = `# 核心人物

## 王五

- **身分**: 法師

# 次要人物

## 王五

- **身分**: 商人
`;
        const xml = deleteEntities([
            { sectionPath: '# 次要人物 > ## 王五', reason: '退場' },
        ], ctxFor(FILE_WITH_DUPES));
        expect(xml).toContain('- **身分**: 商人');
        expect(xml).not.toContain('- **身分**: 法師');
    });

    it('groups multiple deletes into one root-context <save> block', () => {
        const xml = deleteEntities([
            { sectionPath: '# 核心人物 > ## 李四', reason: 'a' },
            { sectionPath: '# 核心人物 > ## 王五', reason: 'b' },
        ], ctxFor(FILE_WITH_BODY));
        expect(xml.match(/<save\b/g)).toHaveLength(1);
        expect(xml.match(/<update>/g)).toHaveLength(2);
        expect(xml).toContain(`<save file="${FILE}" context="">`);
    });

    it('does NOT include the `reason` field in the emitted XML (trace-only)', () => {
        const xml = deleteEntities([
            { sectionPath: '# 核心人物 > ## 王五', reason: '在第三章被反派擊殺' },
        ], ctxFor(FILE_WITH_BODY));
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
        expect(moveEntities([], ctxFor(''))).toBe('');
    });

    it('emits a delete from the source + append under the target group', () => {
        const xml = moveEntities([
            { fromSectionPath: '# 核心人物 > ## 李四', toGroup: '已故人物', reason: '劇情死亡' },
        ], ctxFor(FILE_WITH_BODY));
        // Two save blocks: one root-context delete + one target-group append.
        expect(xml.match(/<save\b/g)).toHaveLength(2);
        expect(xml).toContain(`<save file="${FILE}" context="">`);
        expect(xml).toContain('context="# 已故人物"');
        // The full block text appears in BOTH ops (target of delete + replacement of append).
        const blockCount = (xml.match(/## 李四/g) ?? []).length;
        expect(blockCount).toBe(2);
    });

    it('drops the move when fromSectionPath does not resolve', () => {
        const xml = moveEntities([
            { fromSectionPath: '# 核心人物 > ## 不存在', toGroup: '已故人物', reason: 'x' },
        ], ctxFor(FILE_WITH_BODY));
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
            { fromSectionPath: '# 核心人物 > ## 李四', toGroup: '已故人物', reason: 'a' },
            { fromSectionPath: '# 核心人物 > ## 王五', toGroup: '已故人物', reason: 'b' },
        ], ctxFor(fileContent));
        // 1 delete <save> (both targets) + 1 append <save> (both replacements).
        expect(xml.match(/<save\b/g)).toHaveLength(2);
        expect((xml.match(/<update>/g) ?? []).length).toBe(4);
    });

    it('prepends a newline on each move replacement so multi-move targets get a blank-line separator', () => {
        // Without the leading \n, consecutive moves into the same group land
        // as `## 李四\n…- 劍士\n## 王五` with no blank-line separator. Each
        // <replacement> must begin with \n so the rendered file stays
        // well-formed markdown.
        const fileContent = `# 核心人物

## 李四

- **身分**: 劍士

# 已故人物

`;
        const xml = moveEntities([
            { fromSectionPath: '# 核心人物 > ## 李四', toGroup: '已故人物', reason: 'a' },
        ], ctxFor(fileContent));
        expect(xml).toContain('<replacement>\n## 李四');
    });
});
