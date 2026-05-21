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
        expect(createEntities([], ctxFor(''))).toEqual([]);
    });

    it('emits one append hunk per entity under the L1 group context', () => {
        const updates = createEntities([
            { name: '李四', group: '核心人物', draftedFields: { '身分': '劍士', '基本設定': '人族 / 男 / 25 / 守序善良' } },
        ], ctxFor(''));
        expect(updates).toHaveLength(1);
        expect(updates[0].filePath).toBe(FILE);
        expect(updates[0].context).toBe('# 核心人物');
        expect(updates[0].targetContent).toBeUndefined();
        expect(updates[0].replacementContent).toContain('## 李四');
        expect(updates[0].replacementContent).toContain('- **身分**: 劍士');
        expect(updates[0].replacementContent).toContain('- **基本設定**: 人族 / 男 / 25 / 守序善良');
    });

    it('emits same-group creates as separate hunks sharing the same context', () => {
        const updates = createEntities([
            { name: '李四', group: '核心人物', draftedFields: { f: 'v' } },
            { name: '王五', group: '核心人物', draftedFields: { f: 'v' } },
        ], ctxFor(''));
        expect(updates).toHaveLength(2);
        expect(updates.every(u => u.context === '# 核心人物')).toBe(true);
    });

    it('emits hunks for distinct L1 groups', () => {
        const updates = createEntities([
            { name: '李四', group: '核心人物', draftedFields: { f: 'v' } },
            { name: '某甲', group: '次要人物', draftedFields: { f: 'v' } },
        ], ctxFor(''));
        expect(updates.map(u => u.context)).toEqual(['# 核心人物', '# 次要人物']);
    });

    it('drops entities with no draftedFields (heading-only body would be useless)', () => {
        const updates = createEntities([
            { name: '李四', group: '核心人物', draftedFields: {} },
        ], ctxFor(''));
        expect(updates).toEqual([]);
    });

    it('drops entities missing name or group rather than emitting a broken context', () => {
        const updates = createEntities([
            { name: '', group: '核心人物', draftedFields: { f: 'v' } },
            { name: '李四', group: '', draftedFields: { f: 'v' } },
        ], ctxFor(''));
        expect(updates).toEqual([]);
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
        expect(prefixed).toEqual(bare);
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
        expect(deleteEntities([], ctxFor(''))).toEqual([]);
    });

    it('emits a delete hunk containing the full L2 block when entity is found', () => {
        const updates = deleteEntities([
            { sectionPath: '# 核心人物 > ## 王五', reason: '已故' },
        ], ctxFor(FILE_WITH_BODY));
        expect(updates).toHaveLength(1);
        expect(updates[0].targetContent).toContain('## 王五');
        expect(updates[0].targetContent).toContain('- **身分**: 法師');
        expect(updates[0].replacementContent).toBe('');
        // Should NOT include the sibling's content.
        expect(updates[0].targetContent).not.toContain('李四');
        expect(updates[0].targetContent).not.toContain('某甲');
    });

    it('drops the entry silently when sectionPath does not resolve', () => {
        const updates = deleteEntities([
            { sectionPath: '# 核心人物 > ## 不存在的人', reason: 'x' },
        ], ctxFor(FILE_WITH_BODY));
        expect(updates).toEqual([]);
    });

    it('disambiguates same-name entities across L1 groups by the full breadcrumb', () => {
        const FILE_WITH_DUPES = `# 核心人物

## 王五

- **身分**: 法師

# 次要人物

## 王五

- **身分**: 商人
`;
        const updates = deleteEntities([
            { sectionPath: '# 次要人物 > ## 王五', reason: '退場' },
        ], ctxFor(FILE_WITH_DUPES));
        expect(updates[0].targetContent).toContain('- **身分**: 商人');
        expect(updates[0].targetContent).not.toContain('- **身分**: 法師');
    });

    it('emits multiple deletes as separate hunks sharing root context', () => {
        const updates = deleteEntities([
            { sectionPath: '# 核心人物 > ## 李四', reason: 'a' },
            { sectionPath: '# 核心人物 > ## 王五', reason: 'b' },
        ], ctxFor(FILE_WITH_BODY));
        expect(updates).toHaveLength(2);
        expect(updates.every(u => u.context === '' && u.filePath === FILE)).toBe(true);
    });

    it('does NOT include the `reason` field in the emitted hunk (trace-only)', () => {
        const updates = deleteEntities([
            { sectionPath: '# 核心人物 > ## 王五', reason: '在第三章被反派擊殺' },
        ], ctxFor(FILE_WITH_BODY));
        const serialised = JSON.stringify(updates);
        expect(serialised).not.toContain('在第三章');
        expect(serialised).not.toContain('reason');
    });
});

describe('moveEntities', () => {
    const FILE_WITH_BODY = `# 核心人物

## 李四

- **身分**: 劍士

# 已故人物

`;

    it('returns empty for empty input', () => {
        expect(moveEntities([], ctxFor(''))).toEqual([]);
    });

    it('emits a delete from the source + append under the target group', () => {
        const updates = moveEntities([
            { fromSectionPath: '# 核心人物 > ## 李四', toGroup: '已故人物', reason: '劇情死亡' },
        ], ctxFor(FILE_WITH_BODY));
        // Two hunks: one root-context delete + one target-group append.
        expect(updates).toHaveLength(2);
        const deleteHunk = updates.find(u => u.context === '' && u.targetContent);
        const appendHunk = updates.find(u => u.context === '# 已故人物');
        expect(deleteHunk?.targetContent).toContain('## 李四');
        expect(deleteHunk?.replacementContent).toBe('');
        expect(appendHunk?.targetContent).toBeUndefined();
        expect(appendHunk?.replacementContent).toContain('## 李四');
    });

    it('drops the move when fromSectionPath does not resolve', () => {
        const updates = moveEntities([
            { fromSectionPath: '# 核心人物 > ## 不存在', toGroup: '已故人物', reason: 'x' },
        ], ctxFor(FILE_WITH_BODY));
        expect(updates).toEqual([]);
    });

    it('emits same-target-group moves as separate hunks per direction', () => {
        const fileContent = `# 核心人物

## 李四

- **身分**: 劍士

## 王五

- **身分**: 法師

# 已故人物

`;
        const updates = moveEntities([
            { fromSectionPath: '# 核心人物 > ## 李四', toGroup: '已故人物', reason: 'a' },
            { fromSectionPath: '# 核心人物 > ## 王五', toGroup: '已故人物', reason: 'b' },
        ], ctxFor(fileContent));
        // 2 deletes + 2 appends.
        expect(updates).toHaveLength(4);
        const deletes = updates.filter(u => u.context === '');
        const appends = updates.filter(u => u.context === '# 已故人物');
        expect(deletes).toHaveLength(2);
        expect(appends).toHaveLength(2);
    });

    it('emits the moved block as the append replacement (handler-side leading newline stripped centrally)', () => {
        const fileContent = `# 核心人物

## 李四

- **身分**: 劍士

# 已故人物

`;
        const updates = moveEntities([
            { fromSectionPath: '# 核心人物 > ## 李四', toGroup: '已故人物', reason: 'a' },
        ], ctxFor(fileContent));
        const append = updates.find(u => u.context === '# 已故人物');
        expect(append?.replacementContent?.startsWith('## 李四')).toBe(true);
    });
});
