import { describe, expect, it } from 'vitest';
import { computeFencedLineMask } from './markdown-fence.util';

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
