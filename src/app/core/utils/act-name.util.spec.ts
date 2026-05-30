import { describe, expect, it } from 'vitest';
import { extractActNumberFromKb } from './act-name.util';

const kb = (...entries: [string, string][]): Map<string, string> => new Map(entries);

describe('extractActNumberFromKb', () => {
  it('returns null when no file contains an act header', () => {
    expect(extractActNumberFromKb(kb(['1.md', 'just prose, no headers']))).toBeNull();
  });

  it('returns null for an empty KB', () => {
    expect(extractActNumberFromKb(kb())).toBeNull();
  });

  it('matches `## Act.N` in an ATX header', () => {
    expect(extractActNumberFromKb(kb(['outline.md', 'intro\n\n## Act.3 - Title\n\nbody']))).toBe(3);
  });

  it('matches `第 N 章` (Traditional Chinese) in an ATX header', () => {
    expect(extractActNumberFromKb(kb(['outline.md', '## 第 7 章 - 標題\n\n內文']))).toBe(7);
  });

  it('takes the highest act number across all headers and files', () => {
    expect(extractActNumberFromKb(kb(
      ['outline.md', '## Act.1\n## Act.2\n## Act.5'],
      ['assets.md', '## Stored Cash (As of Act.4)'],
    ))).toBe(5);
  });

  it('ignores act numbers outside ATX headers (prose mentions)', () => {
    expect(extractActNumberFromKb(kb(['notes.md', 'we are deep into Act.9 of the plot']))).toBeNull();
  });

  it('skips the unfilled template header (no digits)', () => {
    expect(extractActNumberFromKb(kb(['outline.md', '## Act.[編號] - [標題]']))).toBeNull();
  });

  it('tolerates dirty separators in the header', () => {
    expect(extractActNumberFromKb(kb(['outline.md', '### ACT  2 :  The Reckoning']))).toBe(2);
  });

  it('case-insensitive on the Act keyword', () => {
    expect(extractActNumberFromKb(kb(['outline.md', '## act.4']))).toBe(4);
  });

  it('does not match "act" embedded in another word', () => {
    expect(extractActNumberFromKb(kb(['roadmap.md', '## React 2.0 roadmap']))).toBeNull();
  });

  it('does not match a word merely starting with "act" before a later number', () => {
    expect(extractActNumberFromKb(kb(['outline.md', '## Active Quests 5\n## Activity 3']))).toBeNull();
  });

  it('requires a unit word for the Chinese form', () => {
    expect(extractActNumberFromKb(kb(['outline.md', '## 第 2 個房間']))).toBeNull();
  });
});
