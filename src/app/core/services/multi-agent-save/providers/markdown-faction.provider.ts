import { Injectable } from '@angular/core';
import { FactionEntry } from '../multi-agent-save.types';
import { extractL2EntriesByGroup } from '../utils/extract-l2-entries.util';
import { isExcludedEntryName } from '../utils/excluded-entry-names.util';
import { FactionProvider } from './faction-provider.interface';

const FACTION_FILE = '6.勢力與世界.md';

/**
 * Phase 1 default {@link FactionProvider} — mirrors
 * {@link import('./markdown-character.provider').MarkdownCharacterProvider}
 * via the shared {@link extractL2EntriesByGroup} util. Extract-everything
 * policy: every L2 heading with an L1 ancestor becomes a
 * {@link FactionEntry}; the LLM stages decide which entries actually
 * advance (`# 主要勢力` entries simulate; `# 關鍵物品` entries are inert).
 */
@Injectable({ providedIn: 'root' })
export class MarkdownFactionProvider implements FactionProvider {
  listFactions(kbFiles: ReadonlyMap<string, string>): FactionEntry[] {
    const content = kbFiles.get(FACTION_FILE);
    if (!content) return [];
    return extractL2EntriesByGroup(content, { exclude: isExcludedEntryName });
  }
}
