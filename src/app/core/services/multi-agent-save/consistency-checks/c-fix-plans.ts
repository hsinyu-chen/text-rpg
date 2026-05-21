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
 * Sub-1 scope (per plan checklist):
 * - `op: 'remove'` for plans whose title isn't in the plan KB → drop the op
 *   (nothing to remove; the underlying handler would silently no-op).
 * - Empty `title` → drop (handler-side `continue` would silently skip; logging
 *   here surfaces the LLM-emitted-garbage case in the trace).
 *
 * Deferred to later iteration (need cross-domain visibility / body parsing):
 * - orphan-owner: plan whose bound character is in `charactersToDelete` →
 *   connected remove. Needs body-text scan for owner reference.
 * - dup-on-add: same-title repeated `add` in one batch. Not in plan checklist
 *   today; symmetric with inventory's dedupe pass but kept out for scope
 *   discipline.
 *
 * Pure function; caller supplies the KB file snapshot.
 */
export function cFixPlans(
    deltas: readonly PlanDelta[],
    fileContent: string,
): PlansCFixResult {
    if (deltas.length === 0) return { deltas: [], fixes: [] };

    const lines = fileContent.split('\n');
    const out: PlanDelta[] = [];
    const fixes: AutoFixLog[] = [];

    for (const delta of deltas) {
        if (!delta.title) {
            fixes.push({
                domain: 'plans',
                kind: 'dropped-empty-title',
                reason: `${delta.op} with empty title`,
            });
            continue;
        }
        if (delta.op === 'remove') {
            const block = lookupSectionBlock(fileContent, lines, derivePlanAtxPath(delta.title));
            if (!block) {
                fixes.push({
                    domain: 'plans',
                    kind: 'dropped-missing-remove',
                    reason: `remove "${delta.title}" — plan not found in KB`,
                });
                continue;
            }
        }
        out.push(delta);
    }

    return { deltas: out, fixes };
}
