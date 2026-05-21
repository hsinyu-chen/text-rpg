import type { AutoFixLog, SectionUpdate } from '../multi-agent-save.types';
import { unionSourceMessageIds } from '../utils/handler-helpers.util';

export interface SectionCFixResult {
    updates: SectionUpdate[];
    fixes: AutoFixLog[];
}

/**
 * Mechanical C-fix for any `SectionUpdate[]` slice (techEquipmentUpdates /
 * magicSkillsUpdates / worldFeaturesUpdates, and the `updates` arrays inside
 * `EntityUpdate`).
 * See TextRPG_Plans/doing/multi-agent-save-per-domain-checks.md (Sub-1).
 *
 * Sub-1 scope (per plan checklist):
 * - **Same-sectionPath pure-append merge**: when the LLM emits two or more
 *   updates with the same `sectionPath` and `target === undefined` (= append
 *   at section end), merge them into a single update whose replacement is
 *   the concatenation. Order-preserving — the merged update lands at the
 *   first occurrence's position; later occurrences are dropped.
 * - **Empty sectionPath drop**: empty path is a no-op at the handler (matcher
 *   anchors nothing); surface in trace.
 * - **Empty target drop**: `target === ''` matches every position and the
 *   downstream handler refuses such entries — surface here so the trace
 *   names the input rather than letting it disappear silently. Critically,
 *   such an entry is NOT a pure-append candidate; merging it with a sibling
 *   `target===undefined` would produce a combined entry that still carries
 *   `target: ''` and gets dropped wholesale, eating the sibling's content.
 *
 * Out of scope (would be C-flag → A territory):
 * - Two updates with the same `sectionPath` where both carry `target` — the
 *   targets may overlap or be disjoint; merging blindly would corrupt at
 *   least one. Pass through both; the dispatcher emits independent hunks.
 * - Cross-KB same-sectionPath duplicates (tech vs magic vs world). Detection
 *   only — needs LLM to decide which side to keep.
 *
 * Pure function; the runner wraps each `SectionUpdate[]`-shaped field with a
 * label so AutoFixLog reasons can reference the originating field.
 */
export function cFixSectionUpdates(
    updates: readonly SectionUpdate[],
    fieldLabel: string,
): SectionCFixResult {
    if (updates.length === 0) return { updates: [], fixes: [] };

    const fixes: AutoFixLog[] = [];
    // Working array; entries set to null are dropped at the end.
    const working: (SectionUpdate | null)[] = updates.map(u => ({ ...u }));

    // Map sectionPath → first-occurrence index, for pure-append merging.
    const firstAppendAt = new Map<string, number>();

    updates.forEach((u, i) => {
        if (!u.sectionPath) {
            fixes.push({
                domain: 'section',
                kind: 'dropped-empty-sectionPath',
                reason: `${fieldLabel} — update with empty sectionPath`,
            });
            working[i] = null;
            return;
        }
        // Degenerate `target === ''` — handler refuses, we drop with trace.
        // Strict `=== ''` (not `!u.target`) so missing `target` (undefined)
        // still routes to the pure-append branch below.
        if (u.target === '') {
            fixes.push({
                domain: 'section',
                kind: 'dropped-empty-target',
                reason: `${fieldLabel} — ${u.sectionPath}: empty target matches every position; handler refuses`,
            });
            working[i] = null;
            return;
        }
        if (u.target !== undefined) return; // Targeted update — pass through.

        const prevIdx = firstAppendAt.get(u.sectionPath);
        if (prevIdx === undefined) {
            firstAppendAt.set(u.sectionPath, i);
            return;
        }
        // Merge into the first occurrence; mark current as dropped. Union
        // sourceMessageIds — both ops contribute content to the merged
        // replacement so both anchor evidence stays attached.
        const first = working[prevIdx];
        if (!first) return; // shouldn't happen, but be defensive
        const mergedIds = unionSourceMessageIds(first.sourceMessageIds, u.sourceMessageIds);
        working[prevIdx] = {
            ...first,
            replacement: first.replacement + u.replacement,
            ...(mergedIds !== undefined ? { sourceMessageIds: mergedIds } : {}),
        };
        working[i] = null;
        fixes.push({
            domain: 'section',
            kind: 'merged-dup-appends',
            reason: `${fieldLabel} — ${u.sectionPath}: merged into earlier append at same sectionPath`,
        });
    });

    return {
        updates: working.filter((u): u is SectionUpdate => u !== null),
        fixes,
    };
}
