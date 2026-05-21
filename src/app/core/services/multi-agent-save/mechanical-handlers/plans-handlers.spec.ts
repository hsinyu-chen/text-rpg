import { describe, expect, it } from 'vitest';
import { applyPlansDeltas } from './protagonist-handlers';

const FILE = '8.計畫.md';
const HEADINGS = { STORY_OUTLINE_CHRONICLE: '劇情綱要' };
const EMPTY_CTX = { targetFile: FILE, fileContent: '', kbSectionHeadings: HEADINGS };

const FILE_WITH_PLAN = `# 計畫

## 「找回失蹤的妹妹」計畫

* **狀態**: 進行中
* **核心目標**: 找到妹妹的下落
* **進度與狀態更新**:
    - **Act 1**: 確認妹妹被帶往北方
`;

describe('applyPlansDeltas', () => {
    it('returns empty array for empty input', () => {
        expect(applyPlansDeltas([], EMPTY_CTX)).toEqual([]);
    });

    it('emits an append hunk for op:add (wraps title with 「」計畫 heading)', () => {
        const updates = applyPlansDeltas([
            { op: 'add', title: '潛入魔王城', body: '* **狀態**: 規劃中' },
        ], EMPTY_CTX);
        expect(updates).toHaveLength(1);
        expect(updates[0].filePath).toBe(FILE);
        expect(updates[0].context).toBe('');
        expect(updates[0].targetContent).toBeUndefined();
        expect(updates[0].replacementContent).toContain('## 「潛入魔王城」計畫');
        expect(updates[0].replacementContent).toContain('* **狀態**: 規劃中');
    });

    it('prepends a leading newline when the file is non-empty', () => {
        const updates = applyPlansDeltas([
            { op: 'add', title: '新計畫', body: '* x' },
        ], { ...EMPTY_CTX, fileContent: FILE_WITH_PLAN });
        expect(updates[0].replacementContent?.startsWith('\n## ')).toBe(true);
    });

    it('emits heading-only hunk when body is omitted', () => {
        const updates = applyPlansDeltas([
            { op: 'add', title: '佔位' },
        ], EMPTY_CTX);
        expect(updates[0].replacementContent).toBe('## 「佔位」計畫');
    });

    it('emits a delete hunk for op:remove when the plan block is found', () => {
        const updates = applyPlansDeltas([
            { op: 'remove', title: '找回失蹤的妹妹' },
        ], { ...EMPTY_CTX, fileContent: FILE_WITH_PLAN });
        expect(updates).toHaveLength(1);
        expect(updates[0].targetContent).toContain('## 「找回失蹤的妹妹」計畫');
        expect(updates[0].targetContent).toContain('Act 1');
        expect(updates[0].replacementContent).toBe('');
    });

    it('silently drops op:remove when the plan is not in the file', () => {
        const updates = applyPlansDeltas([
            { op: 'remove', title: '不存在的計畫' },
        ], { ...EMPTY_CTX, fileContent: FILE_WITH_PLAN });
        expect(updates).toEqual([]);
    });

    it('emits a replace hunk for op:update when the plan block is found', () => {
        const updates = applyPlansDeltas([
            { op: 'update', title: '找回失蹤的妹妹', body: '* **狀態**: 已完成' },
        ], { ...EMPTY_CTX, fileContent: FILE_WITH_PLAN });
        expect(updates).toHaveLength(1);
        expect(updates[0].targetContent).toContain('## 「找回失蹤的妹妹」計畫');
        expect(updates[0].replacementContent).toContain('## 「找回失蹤的妹妹」計畫');
        expect(updates[0].replacementContent).toContain('* **狀態**: 已完成');
        expect(updates[0].replacementContent).not.toContain('進行中');
    });

    it('falls back to append for op:update when the plan is not in the file', () => {
        const updates = applyPlansDeltas([
            { op: 'update', title: '新計畫', body: '* x' },
        ], { ...EMPTY_CTX, fileContent: FILE_WITH_PLAN });
        // Should be an append, not a stale-target replace.
        expect(updates).toHaveLength(1);
        expect(updates[0].targetContent).toBeUndefined();
        expect(updates[0].replacementContent).toContain('## 「新計畫」計畫');
    });

    it('drops entries with no title rather than emitting a broken heading', () => {
        const updates = applyPlansDeltas([
            { op: 'add', title: '', body: 'x' },
        ], EMPTY_CTX);
        expect(updates).toEqual([]);
    });

    it('strips redundant `「…」計畫` wrapping the model added to `title` (defensive)', () => {
        // Bare, fully-wrapped, and partially-wrapped inputs all collapse to the
        // same emitted heading — schema says bare, but models drift.
        const bare = applyPlansDeltas([
            { op: 'add', title: '潛入魔王城', body: 'x' },
        ], EMPTY_CTX);
        const wrapped = applyPlansDeltas([
            { op: 'add', title: '「潛入魔王城」計畫', body: 'x' },
        ], EMPTY_CTX);
        const bracketsOnly = applyPlansDeltas([
            { op: 'add', title: '「潛入魔王城」', body: 'x' },
        ], EMPTY_CTX);
        expect(wrapped).toEqual(bare);
        expect(bracketsOnly).toEqual(bare);
    });
});
