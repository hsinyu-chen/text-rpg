import { describe, expect, it } from 'vitest';
import {
  createIndexMapper,
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

describe('createIndexMapper', () => {
  it('returns the original index for forward queries', () => {
    const mapper = createIndexMapper('  abc  def  ');
    // Normalized: "abcdef". Index 0='a' at original 2; index 3='d' at 7.
    expect(mapper(0)).toBe(2);
    expect(mapper(3)).toBe(7);
    expect(mapper(5)).toBe(9);
  });

  it('returns original.length when normalizedIndex is past the end', () => {
    expect(createIndexMapper('abc')(99)).toBe(3);
  });

  it('handles backward queries by resetting the cursor (overlapping match case)', () => {
    // Regression: findMatchRange permits overlapping matches via
    // searchStart=normalizedIndex+1, so the mapper sees backward jumps.
    // Without reset, the loop would skip past the target and return EOF.
    const mapper = createIndexMapper('abcdef');
    expect(mapper(2)).toBe(2); // forward: 'c'
    expect(mapper(4)).toBe(4); // forward: 'e'
    expect(mapper(1)).toBe(1); // BACKWARD: must reset and find 'b'
    expect(mapper(3)).toBe(3); // forward again from reset position
  });

  it('survives repeated backward jumps without corruption', () => {
    const mapper = createIndexMapper('xyz xyz xyz');
    // Normalized: "xyzxyzxyz" — same chars repeat, mapper must rewind cleanly.
    expect(mapper(5)).toBe(6); // 2nd 'z'
    expect(mapper(0)).toBe(0); // backward to 1st 'x'
    expect(mapper(7)).toBe(9); // 3rd 'y'
    expect(mapper(2)).toBe(2); // backward to 1st 'z'
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
    const content = '# Top\nbody\n# Other\nstuff';
    expect(findMatchRange(content, 'stuff', ['Nowhere'])).toBeNull();
  });

  it('picks the candidate with the highest context score', () => {
    const content = '# A\n## B\nneedle\n# X\nneedle';
    const range = findMatchRange(content, 'needle', ['A', 'B']);
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

  it('context crumb matches file heading WITH parenthetical suffix (half-width)', () => {
    const content = '# 異世界香料/植物(發現時更新)\nbody\n';
    const range = findMatchRange(content, 'body', ['異世界香料/植物']);
    expect(range).not.toBeNull();
  });

  it('context crumb matches file heading WITH parenthetical suffix (full-width)', () => {
    const content = '# 異世界香料/植物（發現時更新）\nbody\n';
    const range = findMatchRange(content, 'body', ['異世界香料/植物']);
    expect(range).not.toBeNull();
  });
});

describe('findInsertionPoint', () => {
  it('returns lines.length when no context provided', () => {
    expect(findInsertionPoint(['# A', 'body'])).toBe(2);
  });

  it('returns lines.length when context is empty array', () => {
    expect(findInsertionPoint(['# A', 'body'], [])).toBe(2);
  });

  it('returns -1 when context is given but no crumb matches', () => {
    expect(findInsertionPoint(['# Real', 'body'], ['Missing'])).toBe(-1);
  });

  it('inserts at end of section when crumb matches header', () => {
    expect(findInsertionPoint(['# A', 'body', '# B'], ['A'])).toBe(2);
  });

  it('walks a multi-level crumb path before computing boundary', () => {
    const lines = ['# Top', '## Sub', 'body', '### Deep', 'd', '# Other'];
    expect(findInsertionPoint(lines, ['Top', 'Sub'])).toBe(5);
  });

  it('falls through to EOF when no terminating header follows', () => {
    expect(findInsertionPoint(['# Top', 'a', 'b'], ['Top'])).toBe(3);
  });

  it('blocks crumb match inside a fence', () => {
    const lines = ['# Real', 'body', '```', '## fake', '```', '# After'];
    expect(findInsertionPoint(lines, ['fake'])).toBe(-1);
  });

  it('falls back to body-text crumbs (e.g. list items) and inserts right after the anchor', () => {
    const lines = ['# Real', '- 「foo」計畫', '# After'];
    // Anchor is a list-item, not a heading — insert right after (line 2), not at EOF.
    expect(findInsertionPoint(lines, ['foo'])).toBe(2);
  });

  it('list-item crumb under a heading parent (real LLM hunk shape)', () => {
    const lines = [
      '# 計畫',
      '## 執行中',
      '- 「**解讀太初殘片**」計畫',
      '  - **目標**: x',
      '- 「**生存基盤**」計畫',
      '  - **目標**: y',
    ];
    // Heading + list-item crumbs together — lands on the matching bullet line.
    expect(findInsertionPoint(lines, ['執行中', '解讀太初殘片'])).toBe(3);
  });

  it('prefers an exact heading match over an earlier body-text mention (tiered scoring)', () => {
    const lines = [
      '# Top',
      'this paragraph mentions Plans by name',
      '## Plans',
      'real body',
      '# After',
    ];
    // Old "first match wins" lands on line 1; tiered scoring picks the exact `## Plans` at line 2.
    expect(findInsertionPoint(lines, ['Plans'])).toBe(4);
  });

  it('prefers a prefix heading match over a substring body match', () => {
    const lines = [
      '# Top',
      'sub appears once in this paragraph',
      '## Sub (note)',
      'real body',
      '# After',
    ];
    // `Sub` is prefix of `Sub (note)` (score 2), substring of body (score 1). Prefix wins.
    expect(findInsertionPoint(lines, ['Sub'])).toBe(4);
  });

  it('filters empty-string crumbs out (treats them as no-op, not catastrophic match)', () => {
    const lines = ['# Real', 'body', '# After'];
    // `[""]` would otherwise match every line via `includes("")` — filtered to `[]` = file root.
    expect(findInsertionPoint(lines, [''])).toBe(lines.length);
  });

  it('filters empty crumbs from a mixed array, keeping the meaningful ones', () => {
    const lines = ['# Real', 'body', '# After'];
    expect(findInsertionPoint(lines, ['', 'Real', ''])).toBe(2);
  });

  it('boundary scan skips fenced fake-headings of equal level', () => {
    const lines = ['# Top', 'body', '```', '# fake-equal-level', '```', 'more body', '# After'];
    expect(findInsertionPoint(lines, ['Top'])).toBe(6);
  });

  it('skipped-layer tolerance: missing intermediate crumb does not abort', () => {
    const lines = ['# Top', '## Sub', 'body', '# After'];
    expect(findInsertionPoint(lines, ['Top', 'Missing', 'Sub'])).toBe(3);
  });

  it('skipped-layer tolerance: array form can omit intermediate levels entirely', () => {
    const lines = ['# Top', '## Sub', 'body', '### Deep', 'd', '# Other'];
    // Array form: just write the headings you care about, in order. The
    // matcher forward-scans and lands on Deep without needing Sub explicit.
    expect(findInsertionPoint(lines, ['Top', 'Deep'])).toBe(5);
  });

  it('matches insertion under parenthetical-suffix heading without the suffix', () => {
    const lines = ['# 異世界香料/植物(發現時更新)', 'old body'];
    expect(findInsertionPoint(lines, ['異世界香料/植物'])).not.toBe(-1);
  });
});

describe('findContextLine', () => {
  it('returns null when context is empty', () => {
    expect(findContextLine('# A', [])).toBeNull();
  });

  it('returns the line index of the last crumb', () => {
    expect(findContextLine('# Top\n## Sub\nbody', ['Top', 'Sub'])).toBe(1);
  });

  it('does not match a crumb inside a fence', () => {
    expect(findContextLine('# Real\n```\n## fake\n```', ['fake'])).toBeNull();
  });

  it('returns null when no crumb matches', () => {
    expect(findContextLine('# Top\nbody', ['Missing'])).toBeNull();
  });
});

describe('inferContextFromLine', () => {
  it('walks back through parent headings as raw heading-text crumbs', () => {
    const content = ['# Top', '## Sub', '### Deep', 'body line'].join('\n');
    expect(inferContextFromLine(content, 3)).toEqual(['Top', 'Sub', 'Deep']);
  });

  it('skips fenced fake-headings while walking back', () => {
    const content = ['# Real', '```', '## fake', '```', 'body line'].join('\n');
    expect(inferContextFromLine(content, 4)).toEqual(['Real']);
  });

  it('returns empty array when no heading exists above', () => {
    expect(inferContextFromLine('plain\ntext', 1)).toEqual([]);
  });

  it('clamps lineIndex to last line when out of bounds', () => {
    const content = ['# Top', 'body'].join('\n');
    expect(inferContextFromLine(content, 99)).toEqual(['Top']);
  });
});
