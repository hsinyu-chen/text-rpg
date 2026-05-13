import { describe, expect, it } from 'vitest';
import { WrapSaveXmlPipe } from './wrap-save-xml.pipe';

function run(input: string | null | undefined): string {
    return new WrapSaveXmlPipe().transform(input);
}

describe('WrapSaveXmlPipe', () => {
    it('returns empty string for nullish input', () => {
        expect(run(null)).toBe('');
        expect(run(undefined)).toBe('');
        expect(run('')).toBe('');
    });

    it('passes through plain text untouched', () => {
        expect(run('hello world')).toBe('hello world');
    });

    it('wraps a single complete <save> block', () => {
        const input = `before\n<save file="x.md">body</save>\nafter`;
        const result = run(input);
        expect(result).toBe('before\n\n```xml\n<save file="x.md">body</save>\n```\n\nafter');
    });

    it('wraps multiple complete blocks independently', () => {
        const input = `<save file="a">A</save>\nmid\n<save file="b">B</save>`;
        const result = run(input);
        expect(result).toContain('```xml\n<save file="a">A</save>\n```');
        expect(result).toContain('```xml\n<save file="b">B</save>\n```');
        // Mid text preserved between the two fences.
        expect(result).toMatch(/```\s+mid\s+```xml/);
    });

    it('wraps a streaming partial <save> opener without a close tag', () => {
        const input = `narration <save file="x">partial body so far`;
        const result = run(input);
        expect(result).toBe('narration \n```xml\n<save file="x">partial body so far\n```');
    });

    it('wraps a partial <save> that follows trailing narration with no close tag', () => {
        // Reproduces the streaming bug: model has emitted `<save>` mid-thought
        // and additional text after, but the closing `</save>` has not landed.
        const input = `intro <save file="x">opening...\n\nmore narration after`;
        const result = run(input);
        expect(result).toBe('intro \n```xml\n<save file="x">opening...\n\nmore narration after\n```');
    });

    it('wraps both a complete block and a later partial block in the same buffer', () => {
        // Regression case the previous regex implementation missed: with one
        // complete block already wrapped, the partial later in the stream was
        // left raw and triggered DomSanitizer warnings each chunk.
        const input = `<save file="a">A</save>\ngap text\n<save file="b">partial`;
        const result = run(input);
        expect(result).toContain('```xml\n<save file="a">A</save>\n```');
        expect(result).toContain('```xml\n<save file="b">partial\n```');
        // The partial block must NOT be left as bare HTML in the output.
        expect(result.includes('<save file="b">partial\n```')).toBe(true);
        expect(/<save file="b">partial(?!\s*\n```)/.test(result)).toBe(false);
    });

    it('handles <save> immediately followed by `>` (no attributes)', () => {
        const input = `<save>body</save>`;
        expect(run(input)).toBe('```xml\n<save>body</save>\n```\n');
    });

    it('strips the leading newline when the buffer starts with a save block', () => {
        const input = `<save file="x">A</save>\ntail`;
        const result = run(input);
        expect(result.startsWith('\n')).toBe(false);
        expect(result.startsWith('```xml')).toBe(true);
    });

    it('does not treat `<saved>` or `<savepoint>` as save tags', () => {
        const input = `<saved>nope</saved> and <savepoint>also nope</savepoint>`;
        // Output is byte-equivalent: no wrapping injected.
        expect(run(input)).toBe(input);
    });

    it('keeps content surrounding a partial block intact (no truncation)', () => {
        const input = `prefix\n<save file="x">streaming...`;
        const result = run(input);
        expect(result).toMatch(/^prefix\n\n```xml\n<save/);
        expect(result.endsWith('streaming...\n```')).toBe(true);
    });
});
