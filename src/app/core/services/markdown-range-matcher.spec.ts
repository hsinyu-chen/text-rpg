import { describe, expect, it } from 'vitest';
import {
  findContextLine,
  findInsertionPoint,
  findMatchRange,
  getLineIndexFromCharIndex,
  inferContextFromLine,
  normalizeForComparison,
} from './markdown-range-matcher';

describe('normalizeForComparison', () => {
  it('returns empty for empty input', () => {
    expect(normalizeForComparison('')).toBe('');
  });

  it('strips whitespace and hashes', () => {
    expect(normalizeForComparison('# Foo Bar')).toBe('FooBar');
    expect(normalizeForComparison('  ##  spaced  ')).toBe('spaced');
  });

  it('maps CJK punctuation to ASCII before stripping', () => {
    expect(normalizeForComparison('你好：世界')).toBe('你好:世界');
    expect(normalizeForComparison('（a，b）')).toBe('(a,b)');
    expect(normalizeForComparison('end。')).toBe('end.');
    expect(normalizeForComparison('what？')).toBe('what?');
    expect(normalizeForComparison('hi！')).toBe('hi!');
    expect(normalizeForComparison('em—dash')).toBe('em-dash');
  });
});

describe('getLineIndexFromCharIndex', () => {
  it('returns 0 for char index inside the first line', () => {
    expect(getLineIndexFromCharIndex('hello\nworld', 3)).toBe(0);
  });

  it('returns the line index for chars after newlines', () => {
    expect(getLineIndexFromCharIndex('a\nb\nc', 4)).toBe(2);
  });

  it('handles CRLF line endings', () => {
    // 'a\r\nb\r\nc' indices: a=0 \r=1 \n=2 b=3 \r=4 \n=5 c=6 — 'c' is on line 2.
    expect(getLineIndexFromCharIndex('a\r\nb\r\nc', 6)).toBe(2);
  });
});

describe('findMatchRange', () => {
  it('returns null when target is empty after normalization', () => {
    expect(findMatchRange('content', '   ###   ')).toBeNull();
  });

  it('finds a simple substring match without context', () => {
    const range = findMatchRange('hello world', 'world');
    expect(range).not.toBeNull();
    expect('hello world'.substring(range!.start, range!.end)).toBe('world');
  });

  it('matches across whitespace and hash differences (loose)', () => {
    const range = findMatchRange('# Header One\nbody', 'HeaderOne');
    expect(range).not.toBeNull();
    // After expand+strict bounds the actual matched span covers `Header One`.
    const matched = '# Header One\nbody'.substring(range!.start, range!.end);
    expect(matched.replace(/\s/g, '')).toBe('HeaderOne');
  });

  it('expands range over leading hashes when target starts with #', () => {
    const content = '## Section\nbody';
    const range = findMatchRange(content, '## Section');
    expect(range).not.toBeNull();
    // Expansion swallows the leading hash chars + space.
    expect(content.substring(range!.start, range!.end).startsWith('##')).toBe(true);
  });

  it('returns null when context is given and verification fails', () => {
    // verifyContext walks backward from the match looking for any header that
    // matches the crumb — it doesn't require the match to live INSIDE that
    // section. Use a crumb that genuinely doesn't appear above the match.
    const content = '# Top\nbody\n# Other\nstuff';
    expect(findMatchRange(content, 'stuff', '# Nowhere')).toBeNull();
  });

  it('picks the candidate with the highest context score', () => {
    const content = '# A\n## B\nneedle\n# X\nneedle';
    const range = findMatchRange(content, 'needle', '# A > ## B');
    expect(range).not.toBeNull();
    // Should land on the first `needle` (under A > B), not the one under X.
    expect(range!.start).toBe(content.indexOf('needle'));
  });

  it('swallows leading/trailing horizontal whitespace from target into the range', () => {
    const content = 'before    target    after';
    const range = findMatchRange(content, '    target    ');
    expect(range).not.toBeNull();
    expect(content.substring(range!.start, range!.end)).toBe('    target    ');
  });
});

describe('findInsertionPoint', () => {
  it('returns lines.length when no context provided', () => {
    expect(findInsertionPoint(['# A', 'body'])).toBe(2);
  });

  it('returns -1 when context is given but no crumb matches', () => {
    expect(findInsertionPoint(['# Real', 'body'], '## Missing')).toBe(-1);
  });

  it('inserts at end of section when strict crumb matches header', () => {
    expect(findInsertionPoint(['# A', 'body', '# B'], '# A')).toBe(2);
  });

  it('walks a multi-level crumb path before computing boundary', () => {
    const lines = ['# Top', '## Sub', 'body', '### Deep', 'd', '# Other'];
    expect(findInsertionPoint(lines, '# Top > ## Sub')).toBe(5);
  });

  it('falls through to EOF when no terminating header follows', () => {
    expect(findInsertionPoint(['# Top', 'a', 'b'], '# Top')).toBe(3);
  });

  it('blocks strict-header crumb match inside a fence', () => {
    const lines = ['# Real', 'body', '```', '## fake', '```', '# After'];
    expect(findInsertionPoint(lines, '## fake')).toBe(-1);
  });

  it('blocks loose crumb match inside a fence (stricter than sibling walkers)', () => {
    const lines = ['# Real', 'body', '```', 'fenced needle', '```', '# After'];
    expect(findInsertionPoint(lines, 'needle')).toBe(-1);
  });

  it('boundary scan skips fenced fake-headings of equal level', () => {
    const lines = ['# Top', 'body', '```', '# fake-equal-level', '```', 'more body', '# After'];
    expect(findInsertionPoint(lines, '# Top')).toBe(6);
  });

  it('skipped-layer tolerance: missing intermediate crumb does not abort', () => {
    const lines = ['# Top', '## Sub', 'body', '# After'];
    // Middle crumb absent, walker keeps trying from the same currentLine.
    expect(findInsertionPoint(lines, '# Top > ## Missing > ## Sub')).toBe(3);
  });
});

describe('findContextLine', () => {
  it('returns null when context is empty', () => {
    expect(findContextLine('# A', '')).toBeNull();
  });

  it('returns the line index of the last crumb', () => {
    expect(findContextLine('# Top\n## Sub\nbody', '# Top > ## Sub')).toBe(1);
  });

  it('does not match a strict-header crumb inside a fence', () => {
    expect(findContextLine('# Real\n```\n## fake\n```', '## fake')).toBeNull();
  });

  it('returns null when no crumb matches', () => {
    expect(findContextLine('# Top\nbody', '## Missing')).toBeNull();
  });
});

describe('inferContextFromLine', () => {
  it('walks back through parent headings until a top-level header', () => {
    const content = ['# Top', '## Sub', '### Deep', 'body line'].join('\n');
    expect(inferContextFromLine(content, 3)).toBe('# Top > ## Sub > ### Deep');
  });

  it('skips fenced fake-headings while walking back', () => {
    const content = ['# Real', '```', '## fake', '```', 'body line'].join('\n');
    expect(inferContextFromLine(content, 4)).toBe('# Real');
  });

  it('returns empty string when no heading exists above', () => {
    expect(inferContextFromLine('plain\ntext', 1)).toBe('');
  });

  it('clamps lineIndex to last line when out of bounds', () => {
    const content = ['# Top', 'body'].join('\n');
    expect(inferContextFromLine(content, 99)).toBe('# Top');
  });
});
