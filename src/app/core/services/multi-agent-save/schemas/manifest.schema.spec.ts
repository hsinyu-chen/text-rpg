import { describe, expect, it } from 'vitest';
import { SAVE_MANIFEST_SCHEMA, validateManifest } from './manifest.schema';

describe('SAVE_MANIFEST_SCHEMA', () => {
    it('is a top-level array of hunk objects', () => {
        const s = SAVE_MANIFEST_SCHEMA as { type: string; items: { type: string; required: string[] } };
        expect(s.type).toBe('array');
        expect(s.items.type).toBe('object');
    });

    it('requires file / context / replacement on each hunk; target stays optional', () => {
        const items = (SAVE_MANIFEST_SCHEMA as unknown as {
            items: { required: string[]; properties: Record<string, unknown> };
        }).items;
        expect(items.required).toEqual(['file', 'context', 'replacement']);
        expect(items.properties['target']).toBeDefined();
        expect(items.properties['sourceMessageIds']).toBeDefined();
    });
});

describe('validateManifest', () => {
    it('accepts an empty hunk array', () => {
        expect(validateManifest([]).ok).toBe(true);
    });

    it('rejects when value is not an array', () => {
        expect(validateManifest(null).ok).toBe(false);
        expect(validateManifest({}).ok).toBe(false);
        expect(validateManifest('foo').ok).toBe(false);
    });

    it('accepts an append hunk (no target)', () => {
        const r = validateManifest([
            { file: '4.物品.md', context: '', replacement: '- 長劍' },
        ]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.hunks).toHaveLength(1);
    });

    it('accepts replace / delete hunks', () => {
        const r = validateManifest([
            { file: '3.人物狀態.md', context: '# 核心人物 > ## 李四', target: '舊狀態', replacement: '新狀態' },
            { file: '3.人物狀態.md', context: '# 核心人物 > ## 王五', target: '## 王五\n- 已死', replacement: '' },
        ]);
        expect(r.ok).toBe(true);
    });

    it('accepts a hunk carrying sourceMessageIds', () => {
        const r = validateManifest([
            { file: 'f.md', context: '', replacement: 'x', sourceMessageIds: ['m1', 'm2'] },
        ]);
        expect(r.ok).toBe(true);
    });

    it('rejects a hunk missing file', () => {
        const r = validateManifest([{ context: '', replacement: 'x' }]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/hunk\[0\]\.file/);
    });

    it('rejects a hunk missing context', () => {
        const r = validateManifest([{ file: 'f.md', replacement: 'x' }]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/hunk\[0\]\.context/);
    });

    it('rejects a hunk missing replacement', () => {
        const r = validateManifest([{ file: 'f.md', context: '' }]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/hunk\[0\]\.replacement/);
    });

    it('rejects a non-string target', () => {
        const r = validateManifest([{ file: 'f.md', context: '', replacement: 'x', target: 42 }]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/hunk\[0\]\.target/);
    });

    it('rejects a non-string-array sourceMessageIds', () => {
        const r = validateManifest([{ file: 'f.md', context: '', replacement: 'x', sourceMessageIds: [1] }]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/hunk\[0\]\.sourceMessageIds/);
    });

    it('rejects a non-object hunk', () => {
        const r = validateManifest(['not a hunk']);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/hunk\[0\]/);
    });

    it('salvages the valid prefix when a tail hunk is malformed (truncation)', () => {
        const r = validateManifest([
            { file: 'a.md', context: '', replacement: 'x' },
            { file: 'b.md', context: '' }, // truncated tail — missing replacement
        ]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.hunks).toEqual([{ id: 'H1', file: 'a.md', context: '', replacement: 'x' }]);
    });

    it('stamps sequential H-ids on the validated hunks', () => {
        const r = validateManifest([
            { file: 'a.md', context: '', replacement: 'x' },
            { file: 'b.md', context: '', replacement: 'y' },
            { file: 'c.md', context: '', replacement: 'z' },
        ]);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.hunks.map(h => h.id)).toEqual(['H1', 'H2', 'H3']);
    });

    it('hard-fails when hunk[0] is malformed even in a multi-hunk array', () => {
        const r = validateManifest([
            { file: 'a.md', context: '' }, // missing replacement
            { file: 'b.md', context: '', replacement: 'x' },
        ]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/hunk\[0\]/);
    });
});
