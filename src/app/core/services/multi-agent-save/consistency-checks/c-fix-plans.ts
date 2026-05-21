import type { AutoFixLog, PlanDelta } from '../multi-agent-save.types';
import { dedupeLastWins, derivePlanAtxPath, lookupSectionBlock } from '../utils/handler-helpers.util';

export interface PlansCFixResult {
    deltas: PlanDelta[];
    fixes: AutoFixLog[];
}

/**
 * Mechanical C-fix for `plansDeltas`.
 * See TextRPG_Plans/doing/multi-agent-save-per-domain-checks.md (Sub-1).
 *
 * Two passes — pass 1 dedupes intra-turn batch, pass 2 reconciles with KB.
 * Dedup-first prevents intra-turn cancellation bugs (see c-fix-inventory.ts
 * for the trace).
 *
 * **Pass 1 — same-title dedupe (keep last, regardless of op):**
 * - Same anchor-conflict risk as inventory: the plan handler anchors each
 *   `remove` / `update` op to the file's *original* L2 block text. Two ops
 *   touching the same plan would emit hunks targeting the same block, the
 *   second hunk fails on apply ("target not found"), and the plan is lost.
 * - Dedupe by `title`, keep last. `[remove P, update P]` collapses to
 *   `update P`; `[add P, remove P]` to `remove P`; etc.
 *
 * **Pass 2 — per-delta against KB:**
 * - Empty `title` → drop (handler-side `continue` would silently skip;
 *   logging here surfaces the LLM-emitted-garbage case in the trace).
 * - `op: 'remove'` whose title isn't a single L2 block in the plan KB → drop.
 *   `lookupSectionBlock` returns `null` for both "not found" AND
 *   "ambiguous (multiple matches)"; we can't distinguish here, so the
 *   reason names both possibilities.
 * - `op: 'update'` whose title isn't in the KB → convert to `add` (the
 *   handler already does this silently; surfacing in the trace).
 * - `op: 'add'` whose title IS in the KB:
 *   - with `body` → convert to `update`. The handler's `add` path blindly
 *     appends, which would create a duplicate `## Title` block and corrupt
 *     future `lookupSectionBlock` calls.
 *   - *without* `body` → drop as redundant. Converting to update would
 *     render a heading-only block and clobber any prior body.
 *
 * Deferred to later iteration (need cross-domain visibility / body parsing):
 * - orphan-owner: plan whose bound character is in `charactersToDelete` →
 *   connected remove. Needs body-text scan for owner reference.
 *
 * Pure function; caller supplies the KB file snapshot.
 */
export function cFixPlans(
    deltas: readonly PlanDelta[],
    fileContent: string,
): PlansCFixResult {
    if (deltas.length === 0) return { deltas: [], fixes: [] };

    const fixes: AutoFixLog[] = [];

    // Pass 1: same-title dedupe before KB reconciliation. Empty-title ops
    // are dropped here so they don't pollute the dedupe key space.
    const nonEmpty: PlanDelta[] = [];
    for (const delta of deltas) {
        if (!delta.title) {
            fixes.push({
                domain: 'plans',
                kind: 'dropped-empty-title',
                reason: `plansDeltas — ${delta.op} with empty title`,
            });
            continue;
        }
        nonEmpty.push(delta);
    }
    const intermediate = dedupeLastWins(
        nonEmpty,
        d => d.title,
        d => fixes.push({
            domain: 'plans',
            kind: 'dropped-stale-dup-title',
            reason: `plansDeltas — ${d.op} "${d.title}": dropped (later op on same plan supersedes; handler would otherwise anchor-conflict)`,
        }),
    );

    // Pass 2: reconcile each surviving delta with KB state.
    const lines = fileContent.split('\n');
    const out: PlanDelta[] = [];
    for (const delta of intermediate) {
        const existing = lookupSectionBlock(fileContent, lines, derivePlanAtxPath(delta.title));
        if (delta.op === 'remove' && !existing) {
            fixes.push({
                domain: 'plans',
                kind: 'dropped-missing-remove',
                reason: `plansDeltas — remove "${delta.title}": plan not found or ambiguous in KB`,
            });
            continue;
        }
        if (delta.op === 'update' && !existing) {
            fixes.push({
                domain: 'plans',
                kind: 'update-fallback-to-add',
                reason: `plansDeltas — update "${delta.title}": plan not found or ambiguous in KB, converted to add`,
            });
            out.push({ ...delta, op: 'add' });
            continue;
        }
        if (delta.op === 'add' && existing) {
            if (!delta.body) {
                fixes.push({
                    domain: 'plans',
                    kind: 'dropped-redundant-add',
                    reason: `plansDeltas — add "${delta.title}": plan already in KB and no new body supplied; would overwrite existing body`,
                });
                continue;
            }
            fixes.push({
                domain: 'plans',
                kind: 'add-merged-to-update',
                reason: `plansDeltas — add "${delta.title}": plan already in KB, converted to update`,
            });
            out.push({ ...delta, op: 'update' });
            continue;
        }
        out.push(delta);
    }

    return { deltas: out, fixes };
}
