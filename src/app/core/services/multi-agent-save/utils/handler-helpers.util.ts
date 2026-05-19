import { findMarkdownSections } from '@app/core/services/file-agent/markdown-section.util';

/**
 * Insertion-ordered map-push: `(map[key] ??= []).push(value)` without the
 * pitfalls of nullish-assignment on Map values. Shared across mechanical
 * handlers that group XML ops by some key (sectionPath, L1 group, etc.).
 */
export function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}

/**
 * Looks up a single L2 markdown section by ATX path and returns its verbatim
 * block text (from the heading line through the last body line), suitable
 * for use as a `<target>` in a `<save>` op.
 *
 * Returns `null` for both "not found" AND "ambiguous" (multiple matches) —
 * Phase 1 doesn't disambiguate same-named sections under different L1 parents.
 * Callers (entity-lifecycle delete/move, plans remove/update) silently drop
 * the offending op rather than guess.
 *
 * Pass a pre-split `lines` array alongside `content` so caller-side loops
 * over many keys can split once and reuse — `findMarkdownSections` re-splits
 * internally, but the slice phase here is per-call.
 */
export function lookupSectionBlock(
    content: string,
    lines: readonly string[],
    atxPath: string,
): string | null {
    if (!atxPath) return null;
    const matches = findMarkdownSections(content, atxPath);
    if (matches.length !== 1) return null;
    const { startLine, endLine } = matches[0];
    return lines.slice(startLine, endLine + 1).join('\n');
}
