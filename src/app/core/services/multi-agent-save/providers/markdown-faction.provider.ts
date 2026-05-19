import { Injectable } from '@angular/core';
import { findAtxHeadings } from '@app/core/utils/markdown.util';
import { findMarkdownSections } from '@app/core/services/file-agent/markdown-section.util';
import { FactionEntry } from '../multi-agent-save.types';
import { isExcludedEntryName } from '../utils/excluded-entry-names.util';
import { FactionProvider } from './faction-provider.interface';

const FACTION_FILE = '6.勢力與世界.md';

/**
 * Phase 1 default {@link FactionProvider} — parses `6.勢力與世界.md` with
 * the same extract-everything policy as {@link import('./markdown-character.provider').MarkdownCharacterProvider}:
 * every L2 heading with an L1 ancestor becomes a {@link FactionEntry}, the
 * L1 name rides along as `entry.group` so downstream can categorize. No
 * whitelist of group names — `# 主要勢力` / `# 核心世界觀` / `# 關鍵物品`
 * etc. all flow through; the LLM stages decide which entries actually ACT.
 *
 * Logic mirrors MarkdownCharacterProvider. Two markdown providers is the
 * 2nd occurrence of this L2-walking shape (per Rule of Three, tolerate but
 * extract on the 3rd) — if a future provider needs the same loop, lift
 * into a shared `extract-l2-entries.util.ts` helper. For now keeping the
 * duplication keeps each provider self-contained and easy to delete when
 * Phase 4 swaps them for LLM-driven variants.
 */
@Injectable({ providedIn: 'root' })
export class MarkdownFactionProvider implements FactionProvider {
  listFactions(kbFiles: ReadonlyMap<string, string>): FactionEntry[] {
    const content = kbFiles.get(FACTION_FILE);
    if (!content) return [];

    const lines = content.split('\n');
    const headings = findAtxHeadings(lines);
    const entries: FactionEntry[] = [];

    let currentL1 = '';
    for (const h of headings) {
      if (h.level === 1) {
        currentL1 = h.text;
        continue;
      }
      if (h.level !== 2) continue;
      if (!currentL1) continue;
      if (isExcludedEntryName(h.text)) continue;

      const matches = findMarkdownSections(content, `${currentL1} > ${h.text}`);
      const bounds = matches[0];
      if (!bounds) continue;

      entries.push({
        name: h.text,
        headingPath: `# ${currentL1} > ## ${h.text}`,
        group: currentL1,
        startLine: bounds.startLine,
        endLine: bounds.endLine,
        rawText: lines.slice(bounds.startLine, bounds.endLine + 1).join('\n'),
      });
    }

    return entries;
  }
}
