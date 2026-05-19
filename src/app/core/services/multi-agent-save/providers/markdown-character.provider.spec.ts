import { describe, expect, it } from 'vitest';
import { MarkdownCharacterProvider } from './markdown-character.provider';
import type { CharacterProvider } from './character-provider.interface';

function files(...pairs: [string, string][]): ReadonlyMap<string, string> {
  return new Map(pairs);
}

describe('MarkdownCharacterProvider', () => {
  // Type as the interface so callers `await` matches the contract (impl is
  // sync today, will go async in Phase 4 — specs exercise the interface).
  const provider: CharacterProvider = new MarkdownCharacterProvider();

  it('returns [] when 3.人物狀態.md is absent', async () => {
    expect(await provider.listCharacters(files())).toEqual([]);
  });

  it('returns [] when file has no L2 headings (template-only / empty group placeholders)', async () => {
    const md = ['# 格式定義', '- field', '', '# 已故人物', '無'].join('\n');
    expect(await provider.listCharacters(files(['3.人物狀態.md', md]))).toEqual([]);
  });

  it('extracts every L2 entry regardless of L1 group name (group carried as field)', async () => {
    const md = [
      '# 格式定義',
      '- template',
      '',
      '# 核心人物',
      '',
      '## 露娜',
      '- 身分: NPC',
      '',
      '## 凱爾',
      '- 身分: 對手',
      '',
      '# 次要人物',
      '',
      '## 加魯長老',
      '- 身分: 村長',
      '',
      '# 已故人物',
      '## 老村長',
      '- 身分: 死於去年冬天',
    ].join('\n');

    const entries = await provider.listCharacters(files(['3.人物狀態.md', md]));
    // 已故人物 entries are included — downstream LLM decides they shouldn't ACT.
    expect(entries.map(e => e.name)).toEqual(['露娜', '凱爾', '加魯長老', '老村長']);
    expect(entries.map(e => e.group)).toEqual(['核心人物', '核心人物', '次要人物', '已故人物']);
  });

  it('accepts arbitrary L1 group names (no whitelist of canonical headings)', async () => {
    const md = [
      '# Cast',  // author-chosen heading, not in any canonical schema
      '## Alice',
      '- protagonist',
      '',
      '# 反派陣營',  // mixed-language section name
      '## Bob',
      '- antagonist',
    ].join('\n');
    const entries = await provider.listCharacters(files(['3.人物狀態.md', md]));
    expect(entries.map(e => e.name)).toEqual(['Alice', 'Bob']);
    expect(entries.map(e => e.group)).toEqual(['Cast', '反派陣營']);
  });

  it('builds breadcrumb headingPath with both # and ## prefixes', async () => {
    const md = ['# 核心人物', '', '## 露娜', '- body'].join('\n');
    const entries = await provider.listCharacters(files(['3.人物狀態.md', md]));
    expect(entries[0].headingPath).toBe('# 核心人物 > ## 露娜');
  });

  it('rawText covers the heading line through the last body line and strips trailing blanks', async () => {
    const md = [
      '# 核心人物',
      '',
      '## 露娜',
      '- 身分: NPC',
      '',
      '',
      '## 凱爾',
      '- 身分: 對手',
    ].join('\n');
    const entries = await provider.listCharacters(files(['3.人物狀態.md', md]));
    expect(entries[0].rawText).toBe('## 露娜\n- 身分: NPC');
    expect(entries[0].endLine).toBe(3);
  });

  it('preserves nested L3 sub-headings inside an NPC entry', async () => {
    const md = [
      '# 核心人物',
      '',
      '## 露娜',
      '- 身分: NPC',
      '',
      '### 已知持有重要物品',
      '- 短劍',
      '',
      '## 凱爾',
      '- 對手',
    ].join('\n');
    const entries = await provider.listCharacters(files(['3.人物狀態.md', md]));
    expect(entries[0].name).toBe('露娜');
    expect(entries[0].rawText).toContain('### 已知持有重要物品');
    expect(entries[0].rawText).toContain('- 短劍');
    expect(entries[1].name).toBe('凱爾');
  });

  it('excludes "存檔格式" template entries from every L1 group', async () => {
    const md = [
      '# 核心人物',
      '## 存檔格式',
      '```',
      '## [角色名]',
      '- **身分**: ...',
      '```',
      '',
      '## 露娜',
      '- 身分: NPC',
      '',
      '# 次要人物',
      '## 存檔格式',
      '- 範本說明',
      '',
      '## 加魯',
      '- 身分: 村長',
    ].join('\n');
    const entries = await provider.listCharacters(files(['3.人物狀態.md', md]));
    expect(entries.map(e => e.name)).toEqual(['露娜', '加魯']);
  });

  it('ignores L2 headings that appear before any L1 ancestor', async () => {
    const md = ['## Orphan', '- body', '', '# 核心人物', '## 露娜', '- body'].join('\n');
    const entries = await provider.listCharacters(files(['3.人物狀態.md', md]));
    expect(entries.map(e => e.name)).toEqual(['露娜']);
  });
});
