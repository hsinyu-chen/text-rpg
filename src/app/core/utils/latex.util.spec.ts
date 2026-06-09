import { describe, expect, it } from 'vitest';
import { convertLatexToSymbols, sanitizeLatexToUnicode } from './latex.util';

describe('latex.util', () => {
    describe('sanitizeLatexToUnicode — inline $...$ math', () => {
        it('strips delimiters and converts a tight $\\cmd$', () => {
            expect(sanitizeLatexToUnicode('$\\rightarrow$')).toBe('→');
        });

        it('strips delimiters when the command is padded with spaces', () => {
            expect(sanitizeLatexToUnicode('血量 $ \\rightarrow $ 0')).toBe('血量 → 0');
        });

        it('strips delimiters for multi-token inline math', () => {
            expect(sanitizeLatexToUnicode('$x \\to y$')).toBe('x → y');
        });

        it('does not strand stray dollars after converting commands (regression)', () => {
            expect(sanitizeLatexToUnicode('$ \\to $')).toBe('→');
            expect(sanitizeLatexToUnicode('$ \\to $')).not.toContain('$');
        });

        it('leaves currency-like $ amounts untouched', () => {
            expect(sanitizeLatexToUnicode('$100')).toBe('$100');
            expect(sanitizeLatexToUnicode('價格 $5 到 $10')).toBe('價格 $5 到 $10');
        });
    });

    describe('sanitizeLatexToUnicode — block + delimiter forms', () => {
        it('converts $$...$$ display math', () => {
            expect(sanitizeLatexToUnicode('$$a \\to b$$')).toBe('a → b');
        });

        it('converts \\(...\\) and \\[...\\] delimiters', () => {
            expect(sanitizeLatexToUnicode('\\(x \\to y\\)')).toBe('x → y');
            expect(sanitizeLatexToUnicode('\\[a \\times b\\]')).toBe('a × b');
        });

        it('converts bare commands', () => {
            expect(sanitizeLatexToUnicode('a \\times b')).toBe('a × b');
        });
    });

    describe('convertLatexToSymbols', () => {
        it('repairs corrupted latex then converts to unicode', () => {
            expect(convertLatexToSymbols('$\\rightarrow$')).toBe('→');
        });

        it('returns falsy input unchanged', () => {
            expect(convertLatexToSymbols('')).toBe('');
        });
    });
});
