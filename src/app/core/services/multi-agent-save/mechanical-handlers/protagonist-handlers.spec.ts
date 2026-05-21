import { describe, expect, it } from 'vitest';
import { applyInventoryDeltas } from './protagonist-handlers';

const FILE = '9.物品欄.md';
const HEADINGS = { STORY_OUTLINE_CHRONICLE: '劇情綱要' };

// Shorthand used everywhere below; only `fileContent` actually varies per test.
const ctx = (fileContent: string) => ({ targetFile: FILE, fileContent, kbSectionHeadings: HEADINGS });

describe('applyInventoryDeltas', () => {
    it('returns empty array for an empty delta array', () => {
        expect(applyInventoryDeltas([], ctx(''))).toEqual([]);
    });

    it('appends a new item line for op:add (with details, empty file = no leading newline)', () => {
        const updates = applyInventoryDeltas([
            { op: 'add', item: '長劍', details: '一柄精鋼長劍' },
        ], ctx(''));
        expect(updates).toEqual([
            {
                filePath: FILE,
                context: '',
                // Empty file: no leading newline to avoid a stray blank line at file head.
                replacementContent: '- 長劍 — 一柄精鋼長劍',
            },
        ]);
    });

    it('appends just the item name when details is omitted', () => {
        const updates = applyInventoryDeltas([
            { op: 'add', item: '麻繩' },
        ], ctx(''));
        expect(updates[0].replacementContent).toBe('- 麻繩');
    });

    it('prepends a newline before append when the file already has content', () => {
        const updates = applyInventoryDeltas([
            { op: 'add', item: '麻繩' },
        ], ctx('- 鐵劍'));
        expect(updates[0].replacementContent).toBe('\n- 麻繩');
    });

    it('emits a delete hunk for op:remove when the item line is found', () => {
        const fileContent = '- 鐵劍 (舊)\n- 麻繩\n- 木盾';
        const updates = applyInventoryDeltas([
            { op: 'remove', item: '麻繩' },
        ], ctx(fileContent));
        expect(updates).toEqual([
            {
                filePath: FILE,
                context: '',
                targetContent: '- 麻繩',
                replacementContent: '',
            },
        ]);
    });

    it('silently drops op:remove when no matching line exists', () => {
        const updates = applyInventoryDeltas([
            { op: 'remove', item: '不存在的物品' },
        ], ctx('- 麻繩\n- 木盾'));
        expect(updates).toEqual([]);
    });

    it('emits a replace hunk for op:update when the item line is found', () => {
        const fileContent = '- 鐵劍\n- 木盾';
        const updates = applyInventoryDeltas([
            { op: 'update', item: '鐵劍', details: '刃口出現缺口' },
        ], ctx(fileContent));
        expect(updates).toEqual([
            {
                filePath: FILE,
                context: '',
                targetContent: '- 鐵劍',
                replacementContent: '- 鐵劍 — 刃口出現缺口',
            },
        ]);
    });

    it('falls back to append for op:update when the item is not in the file', () => {
        const updates = applyInventoryDeltas([
            { op: 'update', item: '新發現的卷軸', details: '殘破不堪' },
        ], ctx('- 鐵劍'));
        // Append rather than emit a stale target.
        expect(updates).toHaveLength(1);
        expect(updates[0].targetContent).toBeUndefined();
        expect(updates[0].replacementContent).toBe('\n- 新發現的卷軸 — 殘破不堪');
    });

    it('stacks multiple ops into separate hunks sharing the same file + context', () => {
        const fileContent = '- 鐵劍\n- 木盾';
        const updates = applyInventoryDeltas([
            { op: 'add', item: '麻繩' },
            { op: 'remove', item: '木盾' },
            { op: 'update', item: '鐵劍', details: '刃口出現缺口' },
        ], ctx(fileContent));
        expect(updates).toHaveLength(3);
        expect(updates.every(u => u.filePath === FILE && u.context === '')).toBe(true);
    });

    it('matches item-name on a space-separated quantity suffix ("鐵劍 x1")', () => {
        const fileContent = '- 鐵劍 x1\n- 木盾';
        const updates = applyInventoryDeltas([
            { op: 'update', item: '鐵劍', details: '損壞' },
        ], ctx(fileContent));
        expect(updates[0].targetContent).toBe('- 鐵劍 x1');
    });

    it('only matches markdown list items (skips non-list lines that contain the item name)', () => {
        const fileContent = '## 主物品\n- 鐵劍\n備註：鐵劍出自鍛造師之手';
        const updates = applyInventoryDeltas([
            { op: 'remove', item: '鐵劍' },
        ], ctx(fileContent));
        expect(updates[0].targetContent).toBe('- 鐵劍');
    });

    it('anchors item name on a word-boundary so "短刀" does NOT match "短刀子"', () => {
        const fileContent = '- 短刀子\n- 木盾';
        const updates = applyInventoryDeltas([
            { op: 'remove', item: '短刀' },
        ], ctx(fileContent));
        expect(updates).toEqual([]);
    });

    it('does NOT anchor "v1" against "v1.0" — ASCII dot is not a boundary', () => {
        // Real items have version numbers / file extensions; treating `.`
        // as a boundary would let a stale "v1" item silently overwrite the
        // upgraded "v1.0" row on update.
        const fileContent = '- v1.0\n- 木盾';
        const updates = applyInventoryDeltas([
            { op: 'remove', item: 'v1' },
        ], ctx(fileContent));
        expect(updates).toEqual([]);
    });

    it('matches exact "v1.0" item name (dot inside name, end of line)', () => {
        const fileContent = '- v1.0\n- 木盾';
        const updates = applyInventoryDeltas([
            { op: 'remove', item: 'v1.0' },
        ], ctx(fileContent));
        expect(updates[0].targetContent).toBe('- v1.0');
    });

    it('matches list items written with the `*` marker (CommonMark)', () => {
        const fileContent = '* 鐵劍\n* 木盾';
        const updates = applyInventoryDeltas([
            { op: 'remove', item: '鐵劍' },
        ], ctx(fileContent));
        expect(updates[0].targetContent).toBe('* 鐵劍');
    });

    it('matches list items written with the `+` marker (CommonMark)', () => {
        const fileContent = '+ 鐵劍\n+ 木盾';
        const updates = applyInventoryDeltas([
            { op: 'remove', item: '鐵劍' },
        ], ctx(fileContent));
        expect(updates[0].targetContent).toBe('+ 鐵劍');
    });

    it('matches when item name is followed by a Chinese paren (common LLM output)', () => {
        const fileContent = '- 短刀（藍刃）\n- 木盾';
        const updates = applyInventoryDeltas([
            { op: 'remove', item: '短刀' },
        ], ctx(fileContent));
        expect(updates[0].targetContent).toBe('- 短刀（藍刃）');
    });

    it('falls back to append on op:update when no anchored match exists', () => {
        // Item name "短刀" should not anchor-match "短刀子", so the update
        // should append a new entry rather than silently overwriting the
        // unrelated "短刀子" row.
        const fileContent = '- 短刀子\n- 木盾';
        const updates = applyInventoryDeltas([
            { op: 'update', item: '短刀', details: '從遺跡取得' },
        ], ctx(fileContent));
        expect(updates).toHaveLength(1);
        expect(updates[0].targetContent).toBeUndefined();
        expect(updates[0].replacementContent).toBe('\n- 短刀 — 從遺跡取得');
    });

    it('matches indented list items (preserves leading whitespace in target)', () => {
        // Real KBs nest items under category sub-headings; the target must
        // include the leading whitespace so the matcher sees an exact-match
        // line.
        const fileContent = '## 攜帶\n    - 鐵劍\n    - 木盾';
        const updates = applyInventoryDeltas([
            { op: 'remove', item: '鐵劍' },
        ], ctx(fileContent));
        expect(updates[0].targetContent).toBe('    - 鐵劍');
    });

    it('mirrors the target indent on the update replacement', () => {
        // What the handler emits matches the file column exactly.
        const fileContent = '## 攜帶\n    - 鐵劍\n    - 木盾';
        const updates = applyInventoryDeltas([
            { op: 'update', item: '鐵劍', details: '刃口缺損' },
        ], ctx(fileContent));
        expect(updates[0].replacementContent).toBe('    - 鐵劍 — 刃口缺損');
    });
});
