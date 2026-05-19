import { describe, expect, it } from 'vitest';
import { applyInventoryDeltas } from './protagonist-handlers';

const FILE = '9.物品欄.md';

describe('applyInventoryDeltas', () => {
    it('returns empty string for an empty delta array', () => {
        expect(applyInventoryDeltas([], { targetFile: FILE, fileContent: '' })).toBe('');
    });

    it('appends a new item line for op:add (with details)', () => {
        const xml = applyInventoryDeltas([
            { op: 'add', item: '長劍', details: '一柄精鋼長劍' },
        ], { targetFile: FILE, fileContent: '' });
        expect(xml).toContain(`<save file="${FILE}" context="">`);
        expect(xml).toContain('<replacement>\n- 長劍 — 一柄精鋼長劍</replacement>');
        expect(xml).not.toContain('<target>');
    });

    it('appends just the item name when details is omitted', () => {
        const xml = applyInventoryDeltas([
            { op: 'add', item: '麻繩' },
        ], { targetFile: FILE, fileContent: '' });
        expect(xml).toContain('<replacement>\n- 麻繩</replacement>');
    });

    it('emits a delete op for op:remove when the item line is found', () => {
        const fileContent = '- 鐵劍 (舊)\n- 麻繩\n- 木盾';
        const xml = applyInventoryDeltas([
            { op: 'remove', item: '麻繩' },
        ], { targetFile: FILE, fileContent });
        expect(xml).toContain('<target>- 麻繩</target>');
        expect(xml).toContain('<replacement></replacement>');
    });

    it('silently drops op:remove when no matching line exists', () => {
        const xml = applyInventoryDeltas([
            { op: 'remove', item: '不存在的物品' },
        ], { targetFile: FILE, fileContent: '- 麻繩\n- 木盾' });
        // No matching line → no ops → empty XML
        expect(xml).toBe('');
    });

    it('emits a replace op for op:update when the item line is found', () => {
        const fileContent = '- 鐵劍\n- 木盾';
        const xml = applyInventoryDeltas([
            { op: 'update', item: '鐵劍', details: '刃口出現缺口' },
        ], { targetFile: FILE, fileContent });
        expect(xml).toContain('<target>- 鐵劍</target>');
        expect(xml).toContain('<replacement>- 鐵劍 — 刃口出現缺口</replacement>');
    });

    it('falls back to append for op:update when the item is not in the file', () => {
        const xml = applyInventoryDeltas([
            { op: 'update', item: '新發現的卷軸', details: '殘破不堪' },
        ], { targetFile: FILE, fileContent: '- 鐵劍' });
        // Append rather than emit a stale target — safer for FileUpdateParser.
        expect(xml).toContain('<replacement>\n- 新發現的卷軸 — 殘破不堪</replacement>');
        expect(xml).not.toContain('<target>');
    });

    it('stacks multiple ops into one <save> block', () => {
        const fileContent = '- 鐵劍\n- 木盾';
        const xml = applyInventoryDeltas([
            { op: 'add', item: '麻繩' },
            { op: 'remove', item: '木盾' },
            { op: 'update', item: '鐵劍', details: '刃口出現缺口' },
        ], { targetFile: FILE, fileContent });
        expect(xml.match(/<save\b/g)).toHaveLength(1);
        expect(xml.match(/<update>/g)).toHaveLength(3);
    });

    it('substring-matches the item line (handles "鐵劍 x1" / "鐵劍 (新)" form variants)', () => {
        const fileContent = '- 鐵劍 x1\n- 木盾';
        const xml = applyInventoryDeltas([
            { op: 'update', item: '鐵劍', details: '損壞' },
        ], { targetFile: FILE, fileContent });
        expect(xml).toContain('<target>- 鐵劍 x1</target>');
    });

    it('only matches markdown list items (skips non-list lines that contain the item name)', () => {
        const fileContent = '## 主物品\n- 鐵劍\n備註：鐵劍出自鍛造師之手';
        const xml = applyInventoryDeltas([
            { op: 'remove', item: '鐵劍' },
        ], { targetFile: FILE, fileContent });
        expect(xml).toContain('<target>- 鐵劍</target>');
        // The "備註：鐵劍" line is not a list item — must not be picked.
        expect(xml).not.toContain('備註');
    });

    it('matches indented list items (preserves leading whitespace in target)', () => {
        // Real KBs nest items under category sub-headings:
        //   ## 攜帶
        //     - 鐵劍
        // The target must include the leading whitespace so FileUpdateParser
        // sees an exact-match line.
        const fileContent = '## 攜帶\n    - 鐵劍\n    - 木盾';
        const xml = applyInventoryDeltas([
            { op: 'remove', item: '鐵劍' },
        ], { targetFile: FILE, fileContent });
        expect(xml).toContain('<target>    - 鐵劍</target>');
    });
});
