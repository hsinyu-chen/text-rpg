import { Injectable } from '@angular/core';
import { findAtxHeadings } from '@app/core/utils/markdown.util';
import { findMarkdownSections } from '@app/core/services/file-agent/markdown-section.util';
import { CharacterEntry } from '../multi-agent-save.types';
import { isExcludedEntryName } from '../utils/excluded-entry-names.util';
import { CharacterProvider } from './character-provider.interface';

/**
 * Default `3.人物狀態.md` filename. Hardcoded — the file is part of the
 * canonical KB schema; any Book uses this name.
 */
const CHARACTER_FILE = '3.人物狀態.md';

/**
 * Phase 1 default {@link CharacterProvider} — parses `3.人物狀態.md` via
 * the heading utilities the file-agent already uses (`findAtxHeadings` +
 * `findMarkdownSections`), so section-bound semantics (trailing-blank trim,
 * level-≤2 terminator) stay consistent with KB editor / search-replace.
 *
 * Extract-everything policy: every L2 heading with an L1 ancestor becomes
 * a {@link CharacterEntry}, no domain-level whitelist of group headings.
 * The L1 ancestor name rides along as `entry.group` so downstream (LLM
 * stages, Debug UI) can categorize — e.g. Stage B-2's prompt sees
 * `group: "已故人物"` and decides the entity doesn't ACT. This keeps the
 * extractor robust against KB files that translate headings, add new
 * groups, or otherwise deviate from the canonical schema, and shifts the
 * dead/alive / template-vs-NPC judgment to layers that can reason about
 * context instead of pattern-matching headings.
 *
 * Orphan L2s (no L1 ancestor) are still skipped — that's a structural
 * sanity guard, not a domain filter; a heading with no parent doesn't
 * belong anywhere in the breadcrumb hierarchy `<save context="…">` uses.
 *
 * Pure logic, no DI dependencies — the `@Injectable` decorator is purely
 * for token binding; specs construct via `new MarkdownCharacterProvider()`.
 */
@Injectable({ providedIn: 'root' })
export class MarkdownCharacterProvider implements CharacterProvider {
  listCharacters(kbFiles: ReadonlyMap<string, string>): CharacterEntry[] {
    const content = kbFiles.get(CHARACTER_FILE);
    if (!content) return [];

    const lines = content.split('\n');
    const headings = findAtxHeadings(lines);
    const entries: CharacterEntry[] = [];

    let currentL1 = '';
    for (const h of headings) {
      if (h.level === 1) {
        currentL1 = h.text;
        continue;
      }
      if (h.level !== 2) continue;
      if (!currentL1) continue;
      if (isExcludedEntryName(h.text)) continue;

      // Delegate bounds resolution so trailing-blank trim and terminator
      // detection match the rest of the codebase. Path uses `>` separator
      // and skips the `#` prefix per `findMarkdownSections` parsing rules.
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
