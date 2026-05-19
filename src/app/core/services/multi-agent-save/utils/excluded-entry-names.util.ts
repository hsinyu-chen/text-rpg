/**
 * L2 heading texts that represent author-facing schema templates rather
 * than real entities. The blank-world scenario seeds each L1 section in
 * `3.人物狀態.md` / `6.勢力與世界.md` with a `## 存檔格式` block that
 * shows the expected entry shape; without this filter both markdown
 * providers would surface those templates as simulation targets.
 *
 * Hardcoded blacklist for Phase 1. Phase 2+ swaps to a small-LLM triage
 * step that decides per-entry whether it's a real entity (vs. template,
 * lore footnote, or otherwise non-actor) based on body content — that
 * approach handles arbitrary author-authored placeholder names that we
 * can't anticipate at compile time.
 */
const EXCLUDED_ENTRY_NAMES = new Set<string>([
  '存檔格式',
]);

export function isExcludedEntryName(name: string): boolean {
  return EXCLUDED_ENTRY_NAMES.has(name.trim());
}
