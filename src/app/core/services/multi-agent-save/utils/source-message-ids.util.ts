import type { SaveHunk } from '../multi-agent-save.types';

/**
 * Drops `sourceMessageIds` entries that don't appear in `validIds`. Used after
 * any LLM-authored stage (SaveAgent manifest, advanced-save commit) to prevent
 * fabricated message ids from polluting downstream stages whose only contract
 * with the chat history is "the id was visible in the rendered prompt".
 *
 * Empty arrays survive (they explicitly mean "no anchors"); omitted arrays
 * stay omitted. Hunks themselves are never dropped — only the bad ids are
 * filtered out, because the hunk's `target` / `replacement` still encodes the
 * actual edit the author wanted.
 */
export function pruneInvalidSourceMessageIds(
    hunks: readonly SaveHunk[],
    validIds: ReadonlySet<string>,
): { hunks: SaveHunk[]; warnings: string[] } {
    const warnings: string[] = [];
    const out = hunks.map(h => {
        const ids = h.sourceMessageIds;
        if (ids === undefined) return h;
        const kept: string[] = [];
        const dropped: string[] = [];
        for (const id of ids) {
            if (validIds.has(id)) kept.push(id);
            else dropped.push(id);
        }
        if (dropped.length === 0) return h;
        warnings.push(`hunk "${h.id}" dropped ${dropped.length} unknown sourceMessageId(s): ${dropped.map(d => `"${d}"`).join(', ')}`);
        return { ...h, sourceMessageIds: kept };
    });
    return { hunks: out, warnings };
}
