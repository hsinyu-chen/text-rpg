import type { AutoFixLog, SectionUpdate } from '../multi-agent-save.types';

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
 *   updates with the same `sectionPath` and no `target` (= append at section
 *   end), merge them into a single update whose replacement is the
 *   concatenation. Avoids the "same entry split into two visually-separated
 *   appends" failure mode the plan describes.
 *   Order-preserving — the merged update lands at the first occurrence's
 *   position; later occurrences are dropped.
 * - **Empty sectionPath drop**: empty path is a no-op at the handler (matcher
 *   anchors nothing); surface in trace.
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
        const isPureAppend = u.target === undefined || u.target === '';
        if (!isPureAppend) return;

        const prevIdx = firstAppendAt.get(u.sectionPath);
        if (prevIdx === undefined) {
            firstAppendAt.set(u.sectionPath, i);
            return;
        }
        // Merge into the first occurrence; mark current as dropped.
        const first = working[prevIdx];
        if (!first) return; // shouldn't happen, but be defensive
        working[prevIdx] = {
            ...first,
            replacement: first.replacement + u.replacement,
        };
        working[i] = null;
        fixes.push({
            domain: 'section',
            kind: 'merged-dup-appends',
            reason: `${fieldLabel} — ${u.sectionPath}: merged two appends into one`,
        });
    });

    return {
        updates: working.filter((u): u is SectionUpdate => u !== null),
        fixes,
    };
}
