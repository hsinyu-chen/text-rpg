import { describe, expect, it } from 'vitest';
import {
  buildSearchPattern,
  buildSearchPatternOrLiteral,
  escapeHtml,
  findMatchesInFiles,
  formatCombinedDiffPreview,
  formatHighlightedSnippet,
  formatReplacePreview,
} from './file-search.util';

describe('buildSearchPattern', () => {
  it('builds a case-insensitive global literal pattern by default', () => {
    const re = buildSearchPattern({ query: 'foo', regex: false, wholeWord: false, caseSensitive: false }, true);
    expect(re.flags).toBe('gi');
    expect(re.test('FOO bar')).toBe(true);
  });

  it('honours caseSensitive flag', () => {
    const re = buildSearchPattern({ query: 'foo', regex: false, wholeWord: false, caseSensitive: true }, true);
    expect(re.flags).toBe('g');
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
    expect(re.flags).toBe('g');
    expect(re.test('aaa')).toBe(true);
  });
});

describe('findMatchesInFiles', () => {
  const opts = { regex: false, wholeWord: false, caseSensitive: false };

  it('returns empty for blank/whitespace query', () => {
    const files = new Map([['a.md', 'hello']]);
    expect(findMatchesInFiles(files, { ...opts, query: '' })).toEqual([]);
    expect(findMatchesInFiles(files, { ...opts, query: '   ' })).toEqual([]);
  });

  it('finds a single match with correct line + index', () => {
    const files = new Map([['a.md', 'first line\nsecond foo line']]);
    const results = findMatchesInFiles(files, { ...opts, query: 'foo' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ fileName: 'a.md', lineNumber: 2, matchIndex: 7, matchLength: 3 });
  });

  it('finds multiple matches on the same line', () => {
    const files = new Map([['a.md', 'foo bar foo baz foo']]);
    const results = findMatchesInFiles(files, { ...opts, query: 'foo' });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.matchIndex)).toEqual([0, 8, 16]);
  });

  it('walks multiple files', () => {
    const files = new Map([
      ['a.md', 'foo'],
      ['b.md', 'foo\nfoo'],
    ]);
    const results = findMatchesInFiles(files, { ...opts, query: 'foo' });
    expect(results.map((r) => r.fileName)).toEqual(['a.md', 'b.md', 'b.md']);
  });

  it('truncates lineContent to 100 chars and trims', () => {
    const longLine = '   ' + 'x'.repeat(500) + ' foo end';
    const files = new Map([['a.md', longLine]]);
    const results = findMatchesInFiles(files, { ...opts, query: 'foo' });
    expect(results[0].lineContent.length).toBe(100);
    expect(results[0].lineContent.startsWith(' ')).toBe(false);
  });

  it('honours regex mode', () => {
    const files = new Map([['a.md', 'aaa abb abc']]);
    const results = findMatchesInFiles(files, { ...opts, query: 'a[bc]', regex: true });
    expect(results.map((r) => r.matchIndex)).toEqual([4, 8]);
  });

  it('falls back to literal on invalid regex (does not throw)', () => {
    const files = new Map([['a.md', '(parens)']]);
    const results = findMatchesInFiles(files, { ...opts, query: '(', regex: true });
    expect(results).toHaveLength(1);
    expect(results[0].matchIndex).toBe(0);
  });
});

describe('escapeHtml', () => {
  it('escapes &, <, >, "', () => {
    expect(escapeHtml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('leaves apostrophes alone (consistent with original behaviour)', () => {
    expect(escapeHtml("it's")).toBe("it's");
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

describe('formatReplacePreview', () => {
  it('renders the substituted match in <span class="replace-preview-text">', () => {
    const re = /foo/i;
    const html = formatReplacePreview('say foo loud', 4, 7, re, 'BAR');
    expect(html).toContain('<span class="replace-preview-text">BAR</span>');
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
