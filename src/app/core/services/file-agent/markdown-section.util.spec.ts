import { describe, expect, it } from 'vitest';
import {
  ambiguousSectionError,
  findMarkdownSections,
  getDescendantHeaders,
  insertSectionIntoContent,
  parseMarkdownOutline,
  resolveSection,
  sectionHasChildren,
} from './markdown-section.util';

describe('parseMarkdownOutline', () => {
  it('returns [] for non-.md filenames', () => {
    expect(parseMarkdownOutline('notes.txt', '# Heading')).toEqual([]);
  });

  it('returns [] for empty content', () => {
    expect(parseMarkdownOutline('foo.md', '')).toEqual([]);
  });

  it('returns [] for missing filename', () => {
    expect(parseMarkdownOutline('', '# Heading')).toEqual([]);
  });

  it('parses each ATX heading with level and 1-indexed lineNumber', () => {
    const md = ['# Top', 'body', '## Sub', '### Deeper', 'tail'].join('\n');
    expect(parseMarkdownOutline('a.md', md)).toEqual([
      { level: 1, text: 'Top', lineNumber: 1 },
      { level: 2, text: 'Sub', lineNumber: 3 },
      { level: 3, text: 'Deeper', lineNumber: 4 },
    ]);
  });

  it('trims trailing whitespace from heading text', () => {
    const md = '## Title with trailing spaces   ';
    expect(parseMarkdownOutline('a.md', md)).toEqual([
      { level: 2, text: 'Title with trailing spaces', lineNumber: 1 },
    ]);
  });

  it('skips #-lines inside fenced code blocks', () => {
    const md = ['# Real', '```bash', '# fake comment', 'echo hi', '```', '## Real Two'].join('\n');
    expect(parseMarkdownOutline('a.md', md)).toEqual([
      { level: 1, text: 'Real', lineNumber: 1 },
      { level: 2, text: 'Real Two', lineNumber: 6 },
    ]);
  });

  it('rejects 7+ hashes (caps at 6)', () => {
    expect(parseMarkdownOutline('a.md', '####### nope')).toEqual([]);
  });

  it('rejects ATX with no space after hashes', () => {
    expect(parseMarkdownOutline('a.md', '##nospace')).toEqual([]);
  });

  it('rejects empty-body ATX (regex requires body chars)', () => {
    expect(parseMarkdownOutline('a.md', '## ')).toEqual([]);
  });
});

describe('findMarkdownSections', () => {
  it('returns [] for empty path', () => {
    expect(findMarkdownSections('# Top', '')).toEqual([]);
  });

  it('returns [] when path is not found', () => {
    expect(findMarkdownSections('# Top\n## Sub', 'Missing')).toEqual([]);
  });

  it('finds a single top-level match', () => {
    const md = ['# Top', 'body', '# Other'].join('\n');
    const result = findMarkdownSections(md, 'Top');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ startLine: 0, endLine: 1, level: 1 });
  });

  it('finds a nested section by full path with ">" separator', () => {
    const md = ['# Top', '## Inner', 'body', '## Other'].join('\n');
    const result = findMarkdownSections(md, 'Top > Inner');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ startLine: 1, endLine: 2, level: 2 });
  });

  it('strips leading hashes from path segments', () => {
    const md = ['# Top', '## Sub'].join('\n');
    const result = findMarkdownSections(md, '# Top > ## Sub');
    expect(result).toHaveLength(1);
    expect(result[0].startLine).toBe(1);
  });

  it('returns multiple matches when path is ambiguous', () => {
    const md = [
      '# Profile A',
      '## Equipment',
      'a',
      '# Profile B',
      '## Equipment',
      'b',
    ].join('\n');
    const result = findMarkdownSections(md, 'Equipment');
    expect(result).toHaveLength(2);
    expect(result[0].startLine).toBe(1);
    expect(result[1].startLine).toBe(4);
  });

  it('disambiguates via parent path', () => {
    const md = [
      '# Profile A',
      '## Equipment',
      'a',
      '# Profile B',
      '## Equipment',
      'b',
    ].join('\n');
    expect(findMarkdownSections(md, 'Profile A > Equipment')).toHaveLength(1);
    expect(findMarkdownSections(md, 'Profile B > Equipment')).toHaveLength(1);
  });

  it('endLine ends at next sibling-or-parent heading', () => {
    const md = ['# A', 'a-body', '# B'].join('\n');
    const result = findMarkdownSections(md, 'A');
    expect(result[0].endLine).toBe(1);
  });

  it('endLine ends at next deeper-then-parent boundary', () => {
    const md = ['# A', '## A1', 'aa', '## A2', '# B'].join('\n');
    const a = findMarkdownSections(md, 'A')[0];
    expect(a.endLine).toBe(3);
  });

  it('endLine extends to last line when no terminator follows', () => {
    const md = ['# A', 'a', 'b'].join('\n');
    const result = findMarkdownSections(md, 'A');
    expect(result[0].endLine).toBe(2);
  });

  it('endLine excludes trailing blank lines', () => {
    const md = ['# A', 'body', '', '', '# B'].join('\n');
    const result = findMarkdownSections(md, 'A');
    expect(result[0].endLine).toBe(1);
  });

  it('captures the full raw heading line as headerText', () => {
    const md = '##   Spaced Title   \nbody';
    const result = findMarkdownSections(md, 'Spaced Title');
    expect(result[0].headerText).toBe('##   Spaced Title   ');
  });

  it('does not match a path segment that lives inside a fenced block', () => {
    const md = ['# Real', '```', '## Fake', '```'].join('\n');
    expect(findMarkdownSections(md, 'Fake')).toEqual([]);
  });
});

describe('resolveSection', () => {
  it('wraps a single match as ok', () => {
    const r = resolveSection('# A\nbody', 'A');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.section.startLine).toBe(0);
  });

  it('returns none when path is missing', () => {
    expect(resolveSection('# A', 'Missing').kind).toBe('none');
  });

  it('returns ambiguous with all matches when multiple sections match', () => {
    const md = ['# X', '## Equipment', '# Y', '## Equipment'].join('\n');
    const r = resolveSection(md, 'Equipment');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.matches).toHaveLength(2);
  });
});

describe('insertSectionIntoContent', () => {
  it('appends to end-of-file when no anchor is given', () => {
    const r = insertSectionIntoContent('# A\nbody', '## New', 'new body', undefined, undefined);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.newContent).toBe('# A\nbody\n\n## New\nnew body');
      expect(r.insertedAtLine).toBe(4);
    }
  });

  it('does not double-blank when content already ends with a blank line', () => {
    const r = insertSectionIntoContent('# A\nbody\n', '## New', undefined, undefined, undefined);
    if (!('error' in r)) expect(r.newContent).toBe('# A\nbody\n\n## New');
  });

  it('prepends with a separator blank line', () => {
    const r = insertSectionIntoContent('# A', '# Z', 'z body', 'prepend', undefined);
    if (!('error' in r)) {
      expect(r.newContent).toBe('# Z\nz body\n\n# A');
      expect(r.insertedAtLine).toBe(1);
    }
  });

  it('errors when before/after is requested without anchorSectionPath', () => {
    const r = insertSectionIntoContent('# A', '## X', undefined, 'before', undefined);
    expect('error' in r && r.error).toMatch(/requires anchorSectionPath/);
  });

  it('errors when anchor section is not found', () => {
    const r = insertSectionIntoContent('# A', '## X', undefined, 'after', 'Missing');
    expect('error' in r && r.error).toMatch(/not found/);
  });

  it('errors when anchor section is ambiguous', () => {
    const md = ['# A', '## Same', '# B', '## Same'].join('\n');
    const r = insertSectionIntoContent(md, '## X', undefined, 'after', 'Same');
    expect('error' in r && r.error).toMatch(/ambiguous/);
  });

  it('inserts before the anchor section', () => {
    const md = ['# A', 'a-body', '# B'].join('\n');
    const r = insertSectionIntoContent(md, '# Mid', 'm', 'before', 'B');
    if (!('error' in r)) {
      expect(r.newContent).toBe(['# A', 'a-body', '# Mid', 'm', '', '# B'].join('\n'));
      expect(r.insertedAtLine).toBe(3);
    }
  });

  it('inserts after the anchor section (and append-into uses same insertion point)', () => {
    const md = ['# A', 'a-body', '# B'].join('\n');
    const after = insertSectionIntoContent(md, '## A1', 'aa', 'after', 'A');
    const into = insertSectionIntoContent(md, '## A1', 'aa', 'append-into', 'A');
    if (!('error' in after) && !('error' in into)) {
      expect(after.newContent).toBe(into.newContent);
      expect(after.newContent).toBe(['# A', 'a-body', '', '## A1', 'aa', '# B'].join('\n'));
    }
  });

  it('emits just the heading line when body is undefined', () => {
    const r = insertSectionIntoContent('', '# A', undefined, undefined, undefined);
    if (!('error' in r)) expect(r.newContent).toBe('\n# A');
  });

  it('splits multi-line body across lines', () => {
    const r = insertSectionIntoContent('', '# A', 'line1\nline2', undefined, undefined);
    if (!('error' in r)) expect(r.newContent).toBe('\n# A\nline1\nline2');
  });
});

describe('getDescendantHeaders', () => {
  it('returns [] when section has no children', () => {
    const md = ['# A', 'body', '# B'].join('\n');
    const bounds = findMarkdownSections(md, 'A')[0];
    expect(getDescendantHeaders(md, bounds)).toEqual([]);
  });

  it('returns direct child headers (trimmed)', () => {
    const md = ['# A', '## A1', '## A2', '# B'].join('\n');
    const bounds = findMarkdownSections(md, 'A')[0];
    expect(getDescendantHeaders(md, bounds)).toEqual(['## A1', '## A2']);
  });

  it('returns deeply-nested grandchildren too', () => {
    const md = ['# A', '## A1', '### A1a', '#### A1a-i', '# B'].join('\n');
    const bounds = findMarkdownSections(md, 'A')[0];
    expect(getDescendantHeaders(md, bounds)).toEqual(['## A1', '### A1a', '#### A1a-i']);
  });

  it('skips pseudo-headings inside fenced code blocks', () => {
    const md = ['# A', '```', '## fake', '```', '## real', '# B'].join('\n');
    const bounds = findMarkdownSections(md, 'A')[0];
    expect(getDescendantHeaders(md, bounds)).toEqual(['## real']);
  });
});

describe('sectionHasChildren', () => {
  it('returns false for a leaf section', () => {
    const md = ['# A', 'body', '# B'].join('\n');
    expect(sectionHasChildren(md, findMarkdownSections(md, 'A')[0])).toBe(false);
  });

  it('returns true when at least one descendant exists', () => {
    const md = ['# A', '## A1', '# B'].join('\n');
    expect(sectionHasChildren(md, findMarkdownSections(md, 'A')[0])).toBe(true);
  });
});

describe('ambiguousSectionError', () => {
  it('formats a read-error with 1-indexed startLine and trimmed headerText', () => {
    const err = ambiguousSectionError('read', 'Same', [
      { startLine: 4, headerText: '## Same   ' },
      { startLine: 9, headerText: '## Same' },
    ]);
    expect(err['error']).toMatch(/Ambiguous sectionPath "Same"/);
    expect(err['error']).toMatch(/Refusing to read/);
    expect(err['matches']).toEqual([
      { startLine: 5, headerText: '## Same' },
      { startLine: 10, headerText: '## Same' },
    ]);
  });

  it('switches verb for replace operations', () => {
    const err = ambiguousSectionError('replace', 'X', []);
    expect(err['error']).toMatch(/Refusing to replace/);
  });
});
