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
    it('returns empty for empty input', () => {
        expect(applyPlansDeltas([], EMPTY_CTX)).toBe('');
    });

    it('emits an append op for op:add (wraps title with 「」計畫 heading)', () => {
        const xml = applyPlansDeltas([
            { op: 'add', title: '潛入魔王城', body: '* **狀態**: 規劃中' },
        ], EMPTY_CTX);
        expect(xml).toContain(`<save file="${FILE}" context="">`);
        expect(xml).toContain('## 「潛入魔王城」計畫');
        expect(xml).toContain('* **狀態**: 規劃中');
        expect(xml).not.toContain('<target>');
    });

    it('prepends a leading newline when the file is non-empty', () => {
        const xml = applyPlansDeltas([
            { op: 'add', title: '新計畫', body: '* x' },
        ], { ...EMPTY_CTX, fileContent: FILE_WITH_PLAN });
        expect(xml).toMatch(/<replacement>\n## /);
    });

    it('emits heading-only block when body is omitted', () => {
        const xml = applyPlansDeltas([
            { op: 'add', title: '佔位' },
        ], EMPTY_CTX);
        expect(xml).toContain('<replacement>## 「佔位」計畫</replacement>');
    });

    it('emits a delete op for op:remove when the plan block is found', () => {
        const xml = applyPlansDeltas([
            { op: 'remove', title: '找回失蹤的妹妹' },
        ], { ...EMPTY_CTX, fileContent: FILE_WITH_PLAN });
        expect(xml).toContain('<target>');
        expect(xml).toContain('## 「找回失蹤的妹妹」計畫');
        expect(xml).toContain('Act 1');
        expect(xml).toContain('<replacement></replacement>');
    });

    it('silently drops op:remove when the plan is not in the file', () => {
        const xml = applyPlansDeltas([
            { op: 'remove', title: '不存在的計畫' },
        ], { ...EMPTY_CTX, fileContent: FILE_WITH_PLAN });
        expect(xml).toBe('');
    });

    it('emits a replace op for op:update when the plan block is found', () => {
        const xml = applyPlansDeltas([
            { op: 'update', title: '找回失蹤的妹妹', body: '* **狀態**: 已完成' },
        ], { ...EMPTY_CTX, fileContent: FILE_WITH_PLAN });
        expect(xml).toContain('<target>');
        expect(xml).toContain('## 「找回失蹤的妹妹」計畫');
        // The new body must appear inside the replacement (with the rewrapped heading).
        const replacementBlock = xml.match(/<replacement>([\s\S]*?)<\/replacement>/);
        expect(replacementBlock).not.toBeNull();
        expect(replacementBlock![1]).toContain('## 「找回失蹤的妹妹」計畫');
        expect(replacementBlock![1]).toContain('* **狀態**: 已完成');
        expect(replacementBlock![1]).not.toContain('進行中');
    });

    it('falls back to append for op:update when the plan is not in the file', () => {
        const xml = applyPlansDeltas([
            { op: 'update', title: '新計畫', body: '* x' },
        ], { ...EMPTY_CTX, fileContent: FILE_WITH_PLAN });
        // Should be an append, not a stale-target replace.
        expect(xml).not.toContain('<target>');
        expect(xml).toContain('## 「新計畫」計畫');
    });

    it('drops entries with no title rather than emitting a broken heading', () => {
        const xml = applyPlansDeltas([
            { op: 'add', title: '', body: 'x' },
        ], EMPTY_CTX);
        expect(xml).toBe('');
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
        expect(wrapped).toBe(bare);
        expect(bracketsOnly).toBe(bare);
    });
});
