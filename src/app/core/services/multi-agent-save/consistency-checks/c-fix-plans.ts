import type { AutoFixLog, PlanDelta } from '../multi-agent-save.types';
import { derivePlanAtxPath, lookupSectionBlock } from '../utils/handler-helpers.util';

export interface PlansCFixResult {
    deltas: PlanDelta[];
    fixes: AutoFixLog[];
}

/**
 * Mechanical C-fix for `plansDeltas`.
 * See TextRPG_Plans/doing/multi-agent-save-per-domain-checks.md (Sub-1).
 *
 * Two passes — pass 1 reconciles each delta with the plan KB, pass 2 dedupes:
 *
 * **Pass 1 — per-delta against KB:**
 * - Empty `title` → drop (handler-side `continue` would silently skip; logging
 *   here surfaces the LLM-emitted-garbage case in the trace).
 * - `op: 'remove'` whose title isn't a single L2 block in the plan KB → drop.
 *   `lookupSectionBlock` returns `null` for both "not found" AND
 *   "ambiguous (multiple matches)"; we can't distinguish here, so the
 *   reason names both possibilities.
 *
 * **Pass 2 — same-title dedupe (keep last, regardless of op):**
 * - Same anchor-conflict risk as inventory: the plan handler anchors each
 *   `remove` / `update` op to the file's *original* L2 block text. Two ops
 *   touching the same plan would emit hunks targeting the same block, the
 *   second hunk fails on apply ("target not found"), and the plan is lost.
 * - Dedupe by `title`, keep last. `[remove P, update P]` collapses to
 *   `update P`; `[add P, remove P]` to `remove P`; etc.
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

    const lines = fileContent.split('\n');
    const fixes: AutoFixLog[] = [];

    // Pass 1: per-delta reconciliation against KB.
    const intermediate: PlanDelta[] = [];
    for (const delta of deltas) {
        if (!delta.title) {
            fixes.push({
                domain: 'plans',
                kind: 'dropped-empty-title',
                reason: `plansDeltas — ${delta.op} with empty title`,
            });
            continue;
        }
        if (delta.op === 'remove') {
            const block = lookupSectionBlock(fileContent, lines, derivePlanAtxPath(delta.title));
            if (!block) {
                fixes.push({
                    domain: 'plans',
                    kind: 'dropped-missing-remove',
                    reason: `plansDeltas — remove "${delta.title}": plan not found or ambiguous in KB`,
                });
                continue;
            }
        }
        intermediate.push(delta);
    }

    // Pass 2: same-title dedupe, keep last regardless of op. Avoids the
    // anchor-conflict failure mode where two ops on the same plan emit
    // hunks targeting the same original block.
    const lastIndex = new Map<string, number>();
    intermediate.forEach((delta, i) => lastIndex.set(delta.title, i));
    const out: PlanDelta[] = [];
    intermediate.forEach((delta, i) => {
        if (lastIndex.get(delta.title) !== i) {
            fixes.push({
                domain: 'plans',
                kind: 'dropped-stale-dup-title',
                reason: `plansDeltas — ${delta.op} "${delta.title}": dropped (later op on same plan supersedes; handler would otherwise anchor-conflict)`,
            });
            return;
        }
        out.push(delta);
    });

    return { deltas: out, fixes };
}
