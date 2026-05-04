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

  it('skips ### lines inside a fence even when the fence body looks like an outline', () => {
    const md = [
      '# 格式定義',
      '```',
      '### inside-fence-1',
      '### inside-fence-2',
      '```',
      '# Next',
    ].join('\n');
    expect(parseMarkdownOutline('a.md', md)).toEqual([
      { level: 1, text: '格式定義', lineNumber: 1 },
      { level: 1, text: 'Next', lineNumber: 6 },
    ]);
  });

  it('rejects 7+ hashes (caps at 6)', () => {
    expect(parseMarkdownOutline('a.md', '####### nope')).toEqual([]);
  });

  it('rejects ATX with no space after hashes', () => {
    expect(parseMarkdownOutline('a.md', '##nospace')).toEqual([]);
  });

  it('accepts empty-body ATX (templates rely on bare `### ` placeholders)', () => {
    expect(parseMarkdownOutline('a.md', '## ')).toEqual([
      { level: 2, text: '', lineNumber: 1 },
    ]);
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

  // Mirrors the real `# 格式定義` scenario from blank_world_zh/3.人物狀態.md:
  // a top-level section's body wraps a format-spec doc in a fenced block.
  // The ### lines inside the fence must NOT terminate the parent section's
  // bounds, otherwise the fenced spec gets misclassified as child sections.
  it('section spans through a fenced block whose body looks like sub-headings', () => {
    const md = [
      '# 格式定義',
      '',
      '```',
      '### inside-fence-1',
      '- entry',
      '### inside-fence-2',
      '```',
      '',
      '---',
      '',
      '# Next Real',
    ].join('\n');
    const result = findMarkdownSections(md, '格式定義');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ startLine: 0, level: 1 });
    expect(result[0].endLine).toBe(8);
  });

  it('recognises tilde fences just like backtick fences', () => {
    const md = ['# Real', '~~~', '## Fake', '~~~', '# Real Two'].join('\n');
    expect(findMarkdownSections(md, 'Fake')).toEqual([]);
    const real = findMarkdownSections(md, 'Real')[0];
    expect(real.endLine).toBe(3);
  });

  it('treats an unclosed backtick fence as code through EOF (trailing # ignored)', () => {
    const md = ['# Real', '```', 'no close', '# Fake at EOF'].join('\n');
    expect(findMarkdownSections(md, 'Fake at EOF')).toEqual([]);
    expect(findMarkdownSections(md, 'Real')[0].endLine).toBe(3);
  });

  it('long backtick fence containing inner ``` ignores inner heading', () => {
    const md = ['# Real', '````', '```', '## inner-fake', '```', '````', '## Real Two'].join('\n');
    expect(findMarkdownSections(md, 'inner-fake')).toEqual([]);
    expect(findMarkdownSections(md, 'Real Two')).toHaveLength(1);
  });
});

describe('resolveSection', () => {
  it('wraps a single match as ok', () => {
    expect(resolveSection('# A\nbody', 'A'))
      .toMatchObject({ kind: 'ok', section: { startLine: 0 } });
  });

  it('returns none when path is missing', () => {
    expect(resolveSection('# A', 'Missing')).toMatchObject({ kind: 'none' });
  });

  it('returns ambiguous with all matches when multiple sections match', () => {
    const md = ['# X', '## Equipment', '# Y', '## Equipment'].join('\n');
    const r = resolveSection(md, 'Equipment');
    expect(r).toMatchObject({ kind: 'ambiguous' });
    if (r.kind === 'ambiguous') expect(r.matches).toHaveLength(2);
  });
});

describe('insertSectionIntoContent', () => {
  it('appends to end-of-file when no anchor is given', () => {
    const r = insertSectionIntoContent('# A\nbody', '## New', 'new body', undefined, undefined);
    expect(r).toMatchObject({ newContent: '# A\nbody\n\n## New\nnew body', insertedAtLine: 4 });
  });

  it('does not double-blank when content already ends with a blank line', () => {
    const r = insertSectionIntoContent('# A\nbody\n', '## New', undefined, undefined, undefined);
    expect(r).toMatchObject({ newContent: '# A\nbody\n\n## New' });
  });

  it('prepends with a separator blank line', () => {
    const r = insertSectionIntoContent('# A', '# Z', 'z body', 'prepend', undefined);
    expect(r).toMatchObject({ newContent: '# Z\nz body\n\n# A', insertedAtLine: 1 });
  });

  it('errors when before/after is requested without anchorSectionPath', () => {
    const r = insertSectionIntoContent('# A', '## X', undefined, 'before', undefined);
    expect(r).toMatchObject({ error: expect.stringMatching(/requires anchorSectionPath/) });
  });

  it('errors when anchor section is not found', () => {
    const r = insertSectionIntoContent('# A', '## X', undefined, 'after', 'Missing');
    expect(r).toMatchObject({ error: expect.stringMatching(/not found/) });
  });

  it('errors when anchor section is ambiguous', () => {
    const md = ['# A', '## Same', '# B', '## Same'].join('\n');
    const r = insertSectionIntoContent(md, '## X', undefined, 'after', 'Same');
    expect(r).toMatchObject({ error: expect.stringMatching(/ambiguous/) });
  });

  it('inserts before the anchor section', () => {
    const md = ['# A', 'a-body', '# B'].join('\n');
    const r = insertSectionIntoContent(md, '# Mid', 'm', 'before', 'B');
    expect(r).toMatchObject({
      newContent: ['# A', 'a-body', '# Mid', 'm', '', '# B'].join('\n'),
      insertedAtLine: 3,
    });
  });

  it('inserts after the anchor section (and append-into uses same insertion point)', () => {
    const md = ['# A', 'a-body', '# B'].join('\n');
    const expected = ['# A', 'a-body', '', '## A1', 'aa', '# B'].join('\n');
    expect(insertSectionIntoContent(md, '## A1', 'aa', 'after', 'A')).toMatchObject({ newContent: expected });
    expect(insertSectionIntoContent(md, '## A1', 'aa', 'append-into', 'A')).toMatchObject({ newContent: expected });
  });

  it('emits just the heading line when body is undefined and content is empty', () => {
    expect(insertSectionIntoContent('', '# A', undefined, undefined, undefined))
      .toMatchObject({ newContent: '# A', insertedAtLine: 1 });
  });

  it('splits multi-line body across lines (empty content, no anchor)', () => {
    expect(insertSectionIntoContent('', '# A', 'line1\nline2', undefined, undefined))
      .toMatchObject({ newContent: '# A\nline1\nline2', insertedAtLine: 1 });
  });

  it('prepend into empty content does not leave a trailing blank line', () => {
    expect(insertSectionIntoContent('', '# A', 'body', 'prepend', undefined))
      .toMatchObject({ newContent: '# A\nbody', insertedAtLine: 1 });
  });

  it('errors when the requested anchor only exists inside a fenced block', () => {
    const md = ['# Real', '```', '## Fenced', '```'].join('\n');
    const r = insertSectionIntoContent(md, '## X', undefined, 'after', 'Fenced');
    expect(r).toMatchObject({ error: expect.stringMatching(/not found/) });
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

  it('returns [] for a section whose ENTIRE body is a fenced spec (no real children)', () => {
    const md = [
      '# 格式定義',
      '```',
      '### fake-1',
      '### fake-2',
      '```',
      '# Next',
    ].join('\n');
    const bounds = findMarkdownSections(md, '格式定義')[0];
    expect(getDescendantHeaders(md, bounds)).toEqual([]);
    expect(sectionHasChildren(md, bounds)).toBe(false);
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
