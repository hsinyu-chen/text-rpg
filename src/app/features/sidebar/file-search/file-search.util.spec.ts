import { describe, expect, it } from 'vitest';
import {
  applyReplacementAt,
  buildSearchPattern,
  buildSearchPatternOrLiteral,
  effectiveRegexMode,
  escapeHtml,
  escapeReplacement,
  findMatchesInLines,
  formatCombinedDiffPreview,
  formatHighlightedSnippet,
} from './file-search.util';

const split = (content: string): string[] => content.split('\n');
const filesToLines = (files: Map<string, string>): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  files.forEach((content, fileName) => out.set(fileName, split(content)));
  return out;
};

describe('buildSearchPattern', () => {
  it('builds a case-insensitive global+multiline literal pattern by default', () => {
    const re = buildSearchPattern({ query: 'foo', regex: false, wholeWord: false, caseSensitive: false }, true);
    expect(re.flags.split('').sort().join('')).toBe('gim');
    expect(re.test('FOO bar')).toBe(true);
  });

  it('honours caseSensitive flag', () => {
    const re = buildSearchPattern({ query: 'foo', regex: false, wholeWord: false, caseSensitive: true }, true);
    expect(re.flags.split('').sort().join('')).toBe('gm');
    expect(re.test('FOO')).toBe(false);
    expect(re.test('foo')).toBe(true);
  });

  it('escapes regex metachars in literal mode', () => {
    const re = buildSearchPattern({ query: 'a.b', regex: false, wholeWord: false, caseSensitive: true }, false);
    expect(re.test('aXb')).toBe(false);
    expect(re.test('a.b')).toBe(true);
  });

  it('wraps wholeWord with \\b boundaries', () => {
    const re = buildSearchPattern({ query: 'foo', regex: false, wholeWord: true, caseSensitive: true }, false);
    expect(re.test('foobar')).toBe(false);
    expect(re.test('foo bar')).toBe(true);
  });

  it('passes regex through verbatim when regex flag is set', () => {
    const re = buildSearchPattern({ query: 'a+b', regex: true, wholeWord: false, caseSensitive: true }, false);
    expect(re.test('aaab')).toBe(true);
    expect(re.test('ab')).toBe(true);
    expect(re.test('xy')).toBe(false);
  });

  it('throws on invalid regex', () => {
    expect(() => buildSearchPattern({ query: '(', regex: true, wholeWord: false, caseSensitive: true }, false)).toThrow();
  });

  it('omits g flag when global=false', () => {
    const re = buildSearchPattern({ query: 'foo', regex: false, wholeWord: false, caseSensitive: true }, false);
    expect(re.flags).toBe('');
  });
});

describe('buildSearchPatternOrLiteral', () => {
  it('falls back to literal-escaped pattern when regex is invalid', () => {
    const re = buildSearchPatternOrLiteral({ query: '(', regex: true, wholeWord: false, caseSensitive: true }, false);
    expect(re.test('(')).toBe(true);
    expect(re.test(')')).toBe(false);
  });

  it('drops wholeWord on fallback (matches dialog historical behaviour)', () => {
    // wholeWord is a literal-mode option; on regex-invalid fallback, callers expect a
    // raw literal match without word-boundary wrapping (see file-viewer dialog history).
    const re = buildSearchPatternOrLiteral({ query: '(', regex: true, wholeWord: true, caseSensitive: true }, false);
    expect(re.source).toBe('\\(');
  });

  it('passes valid regex through', () => {
    const re = buildSearchPatternOrLiteral({ query: 'a+', regex: true, wholeWord: false, caseSensitive: true }, true);
    expect(re.flags.split('').sort().join('')).toBe('gm');
    expect(re.test('aaa')).toBe(true);
  });

  it('replaceAll-style global pattern matches `^` per line, not just file start', () => {
    const re = buildSearchPatternOrLiteral({ query: '^', regex: true, wholeWord: false, caseSensitive: true }, true);
    const replaced = 'a\nb\nc'.replace(re, '> ');
    expect(replaced).toBe('> a\n> b\n> c');
  });
});

describe('findMatchesInLines', () => {
  const opts = { regex: false, wholeWord: false, caseSensitive: false };
  const find = (files: Map<string, string>, o: typeof opts) =>
    findMatchesInLines(filesToLines(files), o);

  it('returns empty for empty query', () => {
    const files = new Map([['a.md', 'hello']]);
    expect(find(files, { ...opts, query: '' })).toEqual([]);
  });

  it('searches for literal whitespace when query is whitespace-only', () => {
    const files = new Map([['a.md', 'a  b\nc d']]);
    const results = find(files, { ...opts, query: '  ' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ lineNumber: 1, matchIndex: 1 });
  });

  it('terminates on zero-width regex matches without infinite loop', () => {
    const files = new Map([['a.md', 'abc']]);
    // `a*` matches `a` at index 0 (length 1), then zero-width at indices 1, 2, 3
    // (after each char + after the line end). The guard advances lastIndex by 1
    // each zero-width hit so the loop terminates after 4 iterations.
    const results = find(files, { ...opts, query: 'a*', regex: true });
    expect(results.map((r) => ({ matchIndex: r.matchIndex, matchLength: r.matchLength }))).toEqual([
      { matchIndex: 0, matchLength: 1 },
      { matchIndex: 1, matchLength: 0 },
      { matchIndex: 2, matchLength: 0 },
      { matchIndex: 3, matchLength: 0 },
    ]);
  });

  it('finds a single match with correct line + index', () => {
    const files = new Map([['a.md', 'first line\nsecond foo line']]);
    const results = find(files, { ...opts, query: 'foo' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ fileName: 'a.md', lineNumber: 2, matchIndex: 7, matchLength: 3 });
  });

  it('finds multiple matches on the same line', () => {
    const files = new Map([['a.md', 'foo bar foo baz foo']]);
    const results = find(files, { ...opts, query: 'foo' });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.matchIndex)).toEqual([0, 8, 16]);
  });

  it('walks multiple files', () => {
    const files = new Map([
      ['a.md', 'foo'],
      ['b.md', 'foo\nfoo'],
    ]);
    const results = find(files, { ...opts, query: 'foo' });
    expect(results.map((r) => r.fileName)).toEqual(['a.md', 'b.md', 'b.md']);
  });

  it('honours regex mode', () => {
    const files = new Map([['a.md', 'aaa abb abc']]);
    const results = find(files, { ...opts, query: 'a[bc]', regex: true });
    expect(results.map((r) => r.matchIndex)).toEqual([4, 8]);
  });

  it('falls back to literal on invalid regex (does not throw)', () => {
    const files = new Map([['a.md', '(parens)']]);
    const results = find(files, { ...opts, query: '(', regex: true });
    expect(results).toHaveLength(1);
    expect(results[0].matchIndex).toBe(0);
  });
});

describe('escapeHtml', () => {
  it('escapes &, <, >, "', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('escapes apostrophes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });
});

describe('effectiveRegexMode', () => {
  it('returns false when regex flag is off', () => {
    expect(effectiveRegexMode({ query: '(', regex: false, wholeWord: false, caseSensitive: false })).toBe(false);
  });

  it('returns true when regex is on and query is a valid pattern', () => {
    expect(effectiveRegexMode({ query: 'a+', regex: true, wholeWord: false, caseSensitive: false })).toBe(true);
  });

  it('returns false when regex is on but query is invalid (matches buildSearchPatternOrLiteral fallback)', () => {
    expect(effectiveRegexMode({ query: '(', regex: true, wholeWord: false, caseSensitive: false })).toBe(false);
  });
});

describe('applyReplacementAt', () => {
  it('replaces the match at the given offset, preserving left context for $`', () => {
    const pattern = /bar/;
    const { newLine, substituted } = applyReplacementAt('foo bar baz', 4, 7, pattern, '[$`]');
    expect(newLine).toBe('foo [foo ] baz');
    expect(substituted).toBe('[foo ]');
  });

  it('honours lookbehind by running against the full line', () => {
    const pattern = /(?<=foo )bar/;
    const { newLine } = applyReplacementAt('foo bar', 4, 7, pattern, 'BAR');
    expect(newLine).toBe('foo BAR');
  });

  it('replaces only at the given offset even if earlier matches exist on the line', () => {
    const pattern = /bar/;
    const { newLine } = applyReplacementAt('bar bar bar', 8, 11, pattern, 'X');
    expect(newLine).toBe('bar bar X');
  });
});

describe('escapeReplacement', () => {
  it('doubles `$` in literal mode so .replace emits a single `$`', () => {
    expect(escapeReplacement('$10', false)).toBe('$$10');
    // String.prototype.replace consumes `$$` → `$`, verify end-to-end
    expect('abc'.replace(/b/, escapeReplacement('$&', false))).toBe('a$&c');
  });

  it('passes regex mode through verbatim so $1 / $& still work', () => {
    expect(escapeReplacement('$&', true)).toBe('$&');
    expect('abc'.replace(/b/, escapeReplacement('[$&]', true))).toBe('a[b]c');
  });
});

describe('formatHighlightedSnippet', () => {
  it('wraps the match in <span class="match-highlight">', () => {
    const html = formatHighlightedSnippet('hello world', 6, 11);
    expect(html).toContain('<span class="match-highlight">world</span>');
  });

  it('adds ... prefix when context is truncated on the left', () => {
    const line = 'a'.repeat(50) + 'TARGET' + 'b'.repeat(50);
    const html = formatHighlightedSnippet(line, 50, 56, 10, 10);
    expect(html.startsWith('...')).toBe(true);
    expect(html.endsWith('...')).toBe(true);
  });

  it('omits ... when at line start/end', () => {
    const html = formatHighlightedSnippet('TARGET', 0, 6);
    expect(html.startsWith('...')).toBe(false);
    expect(html.endsWith('...')).toBe(false);
  });

  it('escapes HTML in surrounding context and match text', () => {
    const html = formatHighlightedSnippet('<a>match</a>', 3, 8);
    expect(html).toContain('&lt;a&gt;');
    expect(html).toContain('<span class="match-highlight">match</span>');
    expect(html).toContain('&lt;/a&gt;');
  });
});

describe('formatCombinedDiffPreview', () => {
  it('renders both removed (old) and added (new) spans', () => {
    const re = /foo/i;
    const html = formatCombinedDiffPreview('say foo loud', 4, 7, re, 'BAR');
    expect(html).toContain('<span class="diff-removed">foo</span>');
    expect(html).toContain('<span class="diff-added">BAR</span>');
  });
});
