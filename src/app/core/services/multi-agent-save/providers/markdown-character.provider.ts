import { Injectable } from '@angular/core';
import { CharacterEntry } from '../multi-agent-save.types';
import { extractL2EntriesByGroup } from '../utils/extract-l2-entries.util';
import { isExcludedEntryName } from '../utils/excluded-entry-names.util';
import { CharacterProvider } from './character-provider.interface';

/**
 * Default `3.人物狀態.md` filename. Hardcoded — the file is part of the
 * canonical KB schema; any Book uses this name.
 */
const CHARACTER_FILE = '3.人物狀態.md';

/**
 * Phase 1 default {@link CharacterProvider} — parses `3.人物狀態.md` via
 * {@link extractL2EntriesByGroup}. Extract-everything policy: every L2
 * heading with an L1 ancestor becomes a {@link CharacterEntry}, no domain
 * whitelist. The L1 ancestor rides along as `entry.group` so downstream
 * (LLM stages, Debug UI) categorizes — `已故人物` entries flow through
 * just like `核心人物` ones; the LLM decides what to do with each.
 *
 * `## 存檔格式` template entries are filtered via the shared blacklist
 * util — those are author-facing schema placeholders, not real entities.
 *
 * Pure logic, no DI dependencies — the `@Injectable` decorator is purely
 * for token binding; specs construct via `new MarkdownCharacterProvider()`.
 */
@Injectable({ providedIn: 'root' })
export class MarkdownCharacterProvider implements CharacterProvider {
  listCharacters(kbFiles: ReadonlyMap<string, string>): CharacterEntry[] {
    const content = kbFiles.get(CHARACTER_FILE);
    if (!content) return [];
    return extractL2EntriesByGroup(content, { exclude: isExcludedEntryName });
  }
}
