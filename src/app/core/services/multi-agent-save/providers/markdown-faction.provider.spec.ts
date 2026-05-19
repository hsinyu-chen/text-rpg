import { describe, expect, it } from 'vitest';
import { MarkdownFactionProvider } from './markdown-faction.provider';
import type { FactionProvider } from './faction-provider.interface';

function files(...pairs: [string, string][]): ReadonlyMap<string, string> {
  return new Map(pairs);
}

describe('MarkdownFactionProvider', () => {
  const provider: FactionProvider = new MarkdownFactionProvider();

  it('returns [] when 6.勢力與世界.md is absent', async () => {
    expect(await provider.listFactions(files())).toEqual([]);
  });

  it('returns [] when file has no L2 headings', async () => {
    const md = ['# 主要勢力', '尚未確立任何勢力', '', '# 核心世界觀', '...'].join('\n');
    expect(await provider.listFactions(files(['6.勢力與世界.md', md]))).toEqual([]);
  });

  it('extracts every L2 entry regardless of L1 group (group carried as field)', async () => {
    const md = [
      '# 主要勢力',
      '## 王國',
      '- 性質: 守護者',
      '',
      '## 魔王軍',
      '- 性質: 敵對',
      '',
      '# 核心世界觀',
      '## 魔王復活',
      '- 來源: 預言',
      '',
      '# 關鍵物品',
      '## 勇者之劍',
      '- 描述: 聖劍',
    ].join('\n');
    const entries = await provider.listFactions(files(['6.勢力與世界.md', md]));
    // 核心世界觀 / 關鍵物品 entries flow through — LLM downstream decides
    // they don't ACT.
    expect(entries.map(e => e.name)).toEqual(['王國', '魔王軍', '魔王復活', '勇者之劍']);
    expect(entries.map(e => e.group)).toEqual(['主要勢力', '主要勢力', '核心世界觀', '關鍵物品']);
  });

  it('builds breadcrumb headingPath with both # and ## prefixes', async () => {
    const md = ['# 主要勢力', '## 王國', '- body'].join('\n');
    const entries = await provider.listFactions(files(['6.勢力與世界.md', md]));
    expect(entries[0].headingPath).toBe('# 主要勢力 > ## 王國');
  });

  it('rawText covers heading through last body line and strips trailing blanks', async () => {
    const md = [
      '# 主要勢力',
      '',
      '## 王國',
      '- 性質: 守護者',
      '',
      '',
      '## 魔王軍',
      '- 性質: 敵對',
    ].join('\n');
    const entries = await provider.listFactions(files(['6.勢力與世界.md', md]));
    expect(entries[0].rawText).toBe('## 王國\n- 性質: 守護者');
    expect(entries[0].endLine).toBe(3);
  });

  it('excludes "存檔格式" template entries from every L1 group (blank-world seed)', async () => {
    const md = [
      '# 主要勢力',
      '## 存檔格式',
      '```',
      '## [勢力名稱]',
      '- **性質**: ...',
      '```',
      '',
      '## 王國',
      '- 性質: 守護者',
      '',
      '# 核心世界觀',
      '## 存檔格式',
      '- 範本說明',
      '',
      '## 魔王復活',
      '- 來源: 預言',
    ].join('\n');
    const entries = await provider.listFactions(files(['6.勢力與世界.md', md]));
    expect(entries.map(e => e.name)).toEqual(['王國', '魔王復活']);
  });

  it('ignores L2 headings that appear before any L1 ancestor', async () => {
    const md = ['## Orphan', '- body', '', '# 主要勢力', '## 王國', '- body'].join('\n');
    const entries = await provider.listFactions(files(['6.勢力與世界.md', md]));
    expect(entries.map(e => e.name)).toEqual(['王國']);
  });
});
