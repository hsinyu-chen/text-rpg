import { describe, expect, it } from 'vitest';
import { saveBlock } from './serialize-save-block.util';

describe('saveBlock', () => {
    it('returns empty string for zero ops', () => {
        expect(saveBlock('9.物品欄.md', '', [])).toBe('');
    });

    it('emits a replace op with target + replacement', () => {
        const xml = saveBlock('9.物品欄.md', '', [
            { kind: 'replace', target: '- 鐵劍 x1', replacement: '- 鐵劍 x1 (缺口)' },
        ]);
        expect(xml).toContain('<save file="9.物品欄.md" context="">');
        expect(xml).toContain('<target>- 鐵劍 x1</target>');
        expect(xml).toContain('<replacement>- 鐵劍 x1 (缺口)</replacement>');
        expect(xml).toContain('</save>');
    });

    it('emits an append op (no target)', () => {
        const xml = saveBlock('9.物品欄.md', '# 物品', [
            { kind: 'append', replacement: '- 新物品' },
        ]);
        expect(xml).toContain('<replacement>- 新物品</replacement>');
        expect(xml).not.toContain('<target>');
    });

    it('emits a delete op (target + empty replacement)', () => {
        const xml = saveBlock('9.物品欄.md', '', [
            { kind: 'delete', target: '- 舊物品' },
        ]);
        expect(xml).toContain('<target>- 舊物品</target>');
        expect(xml).toContain('<replacement></replacement>');
    });

    it('stacks multiple ops inside one save block', () => {
        const xml = saveBlock('9.物品欄.md', '', [
            { kind: 'replace', target: 'a', replacement: 'A' },
            { kind: 'append', replacement: 'B' },
        ]);
        // Single <save> ... </save> wrapper with two <update> children.
        expect(xml.match(/<save\b/g)).toHaveLength(1);
        expect(xml.match(/<update>/g)).toHaveLength(2);
    });

    it('escapes ampersands and quotes in file/context attributes', () => {
        const xml = saveBlock('a&b.md', '# X & "Y"', [
            { kind: 'append', replacement: 'z' },
        ]);
        expect(xml).toContain('file="a&amp;b.md"');
        expect(xml).toContain('context="# X &amp; &quot;Y&quot;"');
    });

    it('drops ops whose target / replacement contains a literal closing tag', () => {
        // No real LLM emits these in practice, but the parser regex would
        // close early on the first match, corrupting the rest of the stream.
        // Better to silently drop than to corrupt.
        const xml = saveBlock('x.md', '', [
            { kind: 'replace', target: '- weird </target> name', replacement: 'r' },
            { kind: 'append', replacement: '- legit' },
        ]);
        // The bad op is dropped; the second op still emits its <save> block.
        expect(xml).toContain('- legit');
        expect(xml).not.toContain('</target> name');
    });

    it('returns empty when every op is dropped (no childless <save> shell)', () => {
        const xml = saveBlock('x.md', '', [
            { kind: 'replace', target: 'foo</target>', replacement: 'bar' },
        ]);
        expect(xml).toBe('');
    });

    it('passes target/replacement content through verbatim (FileUpdateParser does not decode entities)', () => {
        // & in content must survive a roundtrip — escaping it would persist
        // the literal "Salt &amp; Pepper" to disk, breaking subsequent line
        // lookups + the user's reading of the file.
        const xml = saveBlock('x.md', '', [
            { kind: 'replace', target: '- Salt & Pepper', replacement: '- Salt & Pepper (黑胡椒)' },
        ]);
        expect(xml).toContain('<target>- Salt & Pepper</target>');
        expect(xml).toContain('<replacement>- Salt & Pepper (黑胡椒)</replacement>');
        expect(xml).not.toContain('&amp;');
    });
});
