import { describe, expect, it } from 'vitest';
import { extractL2EntriesByGroup } from './extract-l2-entries.util';

describe('extractL2EntriesByGroup', () => {
  it('returns [] for empty content', () => {
    expect(extractL2EntriesByGroup('')).toEqual([]);
  });

  it('returns [] when only L1 headings exist (no L2 children)', () => {
    const md = ['# 主要勢力', '尚未確立', '', '# 核心世界觀', '...'].join('\n');
    expect(extractL2EntriesByGroup(md)).toEqual([]);
  });

  it('emits one entry per L2 heading, carrying its L1 ancestor as `group`', () => {
    const md = [
      '# 核心人物',
      '## 露娜',
      '- NPC',
      '',
      '## 凱爾',
      '- 對手',
      '',
      '# 次要人物',
      '## 加魯',
      '- 村長',
    ].join('\n');
    const entries = extractL2EntriesByGroup(md);
    expect(entries.map(e => e.name)).toEqual(['露娜', '凱爾', '加魯']);
    expect(entries.map(e => e.group)).toEqual(['核心人物', '核心人物', '次要人物']);
  });

  it('builds breadcrumb `# L1 > ## L2`', () => {
    const md = ['# 核心人物', '## 露娜', '- body'].join('\n');
    expect(extractL2EntriesByGroup(md)[0].headingPath).toBe('# 核心人物 > ## 露娜');
  });

  it('rawText strips trailing blank lines (parity with findMarkdownSections)', () => {
    const md = [
      '# 核心人物',
      '## 露娜',
      '- NPC',
      '',
      '',
      '## 凱爾',
      '- 對手',
    ].join('\n');
    const entries = extractL2EntriesByGroup(md);
    expect(entries[0].rawText).toBe('## 露娜\n- NPC');
    expect(entries[0].endLine).toBe(2);
  });

  it('preserves nested L3 sub-sections inside an L2 entry', () => {
    const md = [
      '# 核心人物',
      '## 露娜',
      '- NPC',
      '### 已知持有重要物品',
      '- 短劍',
      '',
      '## 凱爾',
      '- 對手',
    ].join('\n');
    const entries = extractL2EntriesByGroup(md);
    expect(entries[0].rawText).toContain('### 已知持有重要物品');
    expect(entries[0].rawText).toContain('- 短劍');
    expect(entries[1].name).toBe('凱爾');
  });

  it('drops orphan L2 headings (no L1 ancestor)', () => {
    const md = ['## Orphan', '- body', '', '# 核心人物', '## 露娜', '- body'].join('\n');
    expect(extractL2EntriesByGroup(md).map(e => e.name)).toEqual(['露娜']);
  });

  it('REGRESSION: duplicate L2 names produce distinct entries with their own bounds', () => {
    // Previous implementation re-parsed via findMarkdownSections per L2 and
    // took matches[0], so both '露娜' entries collapsed to the first bounds.
    const md = [
      '# 核心人物',
      '## 露娜',
      '- 第一個露娜的內容',
      '',
      '## 露娜',
      '- 第二個露娜的內容(不同條目)',
    ].join('\n');
    const entries = extractL2EntriesByGroup(md);
    expect(entries).toHaveLength(2);
    expect(entries[0].rawText).toContain('第一個露娜的內容');
    expect(entries[0].rawText).not.toContain('第二個');
    expect(entries[1].rawText).toContain('第二個露娜的內容');
    expect(entries[1].rawText).not.toContain('第一個');
    // Bounds must be distinct.
    expect(entries[0].startLine).not.toBe(entries[1].startLine);
  });

  it('REGRESSION: duplicate L2 names under different L1 groups stay independent', () => {
    const md = [
      '# 核心人物',
      '## 同名',
      '- 核心版本',
      '',
      '# 次要人物',
      '## 同名',
      '- 次要版本',
    ].join('\n');
    const entries = extractL2EntriesByGroup(md);
    expect(entries).toHaveLength(2);
    expect(entries[0].group).toBe('核心人物');
    expect(entries[0].rawText).toContain('核心版本');
    expect(entries[1].group).toBe('次要人物');
    expect(entries[1].rawText).toContain('次要版本');
  });

  it('applies the exclude predicate to L2 heading text', () => {
    const md = [
      '# 核心人物',
      '## 存檔格式',
      '- 範本',
      '',
      '## 露娜',
      '- NPC',
    ].join('\n');
    const entries = extractL2EntriesByGroup(md, { exclude: name => name === '存檔格式' });
    expect(entries.map(e => e.name)).toEqual(['露娜']);
  });
});
