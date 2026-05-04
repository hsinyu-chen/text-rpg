import { describe, expect, it } from 'vitest';
import {
  computeFencedLineMask,
  findAtxHeadings,
  parseAtxHeading,
} from './markdown.util';

describe('computeFencedLineMask', () => {
  it('returns all-false for plain markdown with no fences', () => {
    const lines = ['# Heading', 'body', '## Sub', 'more body'];
    expect(computeFencedLineMask(lines)).toEqual([false, false, false, false]);
  });

  it('marks fenced delimiter and content lines', () => {
    const lines = ['# Real', '```', '# fake heading', 'code', '```', '## Real too'];
    expect(computeFencedLineMask(lines)).toEqual([false, true, true, true, true, false]);
  });

  it('rejects backtick fence open whose info string contains a backtick', () => {
    const lines = ['```js`', '# this should still count as a heading', '```'];
    const mask = computeFencedLineMask(lines);
    expect(mask[0]).toBe(false);
    expect(mask[1]).toBe(false);
  });

  it('allows tilde fence with backticks in info string', () => {
    const lines = ['~~~js`hello`', '# fake', '~~~'];
    expect(computeFencedLineMask(lines)).toEqual([true, true, true]);
  });

  it('does not close a backtick fence with a tilde delimiter', () => {
    const lines = ['```', 'code', '~~~', 'still in fence', '```'];
    expect(computeFencedLineMask(lines)).toEqual([true, true, true, true, true]);
  });

  it('closes only when closing length >= opening length', () => {
    const lines = ['````', 'still in', '```', 'still in', '`````'];
    expect(computeFencedLineMask(lines)).toEqual([true, true, true, true, true]);
  });

  it('treats unclosed fence as running to end of file', () => {
    const lines = ['# Real', '```', 'no close', '# fake'];
    expect(computeFencedLineMask(lines)).toEqual([false, true, true, true]);
  });

  it('rejects mixed-character fence opens', () => {
    const lines = ['`~`', '# real heading'];
    const mask = computeFencedLineMask(lines);
    expect(mask[0]).toBe(false);
    expect(mask[1]).toBe(false);
  });
});

describe('parseAtxHeading', () => {
  it('parses level 1–6 with body', () => {
    expect(parseAtxHeading('# Top')).toEqual({ level: 1, text: 'Top' });
    expect(parseAtxHeading('###### Six')).toEqual({ level: 6, text: 'Six' });
  });

  it('accepts empty body (templates rely on this)', () => {
    expect(parseAtxHeading('### ')).toEqual({ level: 3, text: '' });
    expect(parseAtxHeading('###')).toEqual({ level: 3, text: '' });
  });

  it('strips ATX closing sequence from body', () => {
    expect(parseAtxHeading('## Foo ##')).toEqual({ level: 2, text: 'Foo' });
    expect(parseAtxHeading('## Foo #####')).toEqual({ level: 2, text: 'Foo' });
    expect(parseAtxHeading('### ###')).toEqual({ level: 3, text: '' });
  });

  it('tolerates arbitrary leading indent (deliberate spec deviation)', () => {
    expect(parseAtxHeading('   ### deep')).toEqual({ level: 3, text: 'deep' });
    expect(parseAtxHeading('        ## very-deep')).toEqual({ level: 2, text: 'very-deep' });
  });

  it('trims trailing whitespace and CR', () => {
    expect(parseAtxHeading('## Foo   ')).toEqual({ level: 2, text: 'Foo' });
    expect(parseAtxHeading('## Foo\r')).toEqual({ level: 2, text: 'Foo' });
  });

  it('rejects 7+ hashes (CommonMark caps at 6)', () => {
    expect(parseAtxHeading('####### nope')).toBeNull();
  });

  it('rejects no-space-after-hash (CommonMark requires whitespace separator)', () => {
    expect(parseAtxHeading('##nospace')).toBeNull();
    expect(parseAtxHeading('#hashtag')).toBeNull();
  });

  it('returns null for non-heading lines', () => {
    expect(parseAtxHeading('plain text')).toBeNull();
    expect(parseAtxHeading('')).toBeNull();
    expect(parseAtxHeading('  ')).toBeNull();
  });
});

describe('findAtxHeadings', () => {
  it('returns 0-indexed line index, level, and trimmed text', () => {
    const lines = ['# Top', 'body', '## Sub', '### Deeper'];
    expect(findAtxHeadings(lines)).toEqual([
      { index: 0, level: 1, text: 'Top' },
      { index: 2, level: 2, text: 'Sub' },
      { index: 3, level: 3, text: 'Deeper' },
    ]);
  });

  it('skips headings inside fenced code blocks', () => {
    const lines = ['# Real', '```', '# fake', '```', '## Real Two'];
    expect(findAtxHeadings(lines)).toEqual([
      { index: 0, level: 1, text: 'Real' },
      { index: 4, level: 2, text: 'Real Two' },
    ]);
  });

  it('emits empty-body headings (no longer dropped silently)', () => {
    const lines = ['# Top', '## ', 'body'];
    expect(findAtxHeadings(lines)).toEqual([
      { index: 0, level: 1, text: 'Top' },
      { index: 1, level: 2, text: '' },
    ]);
  });
});
