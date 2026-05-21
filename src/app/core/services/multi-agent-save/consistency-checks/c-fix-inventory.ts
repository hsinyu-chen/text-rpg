import type { AutoFixLog, InventoryDelta } from '../multi-agent-save.types';
import { findItemLine } from '../mechanical-handlers/protagonist-handlers';

export interface InventoryCFixResult {
    deltas: InventoryDelta[];
    fixes: AutoFixLog[];
}

/**
 * Mechanical C-fix for `inventoryDeltas` / `assetsDeltas` (same shape,
 * different files). The runner threads `fieldLabel` so trace logs name
 * the actual manifest slot instead of always saying "inventory".
 * See TextRPG_Plans/doing/multi-agent-save-per-domain-checks.md (Sub-1).
 *
 * Two passes — pass 1 reconciles each delta against the KB file state, pass 2
 * dedupes within the resulting batch:
 *
 * **Pass 1 — per-delta against KB:**
 * 1. `op: 'remove'` for items not in KB → drop the op (nothing to remove)
 * 2. `op: 'update'` for items not in KB → convert to `add` (the underlying
 *    handler already does this silently; surfacing it in the trace lets the
 *    user see when the LLM's intent diverged from KB state)
 * 3. `op: 'add'` for items already in KB → convert to `update` so the
 *    existing line is replaced rather than a duplicate appended
 *
 * **Pass 2 — same-item dedupe (keep last, regardless of op):**
 * - The downstream handler anchors every op to the file's *original* state.
 *   If two ops touching the same item both survive, they emit hunks
 *   targeting the same line; FileUpdateService applies them sequentially
 *   and the second one fails ("target not found") — losing the item.
 * - Therefore: dedupe strictly by `item`, keep the *last* op. A
 *   `[remove X, add X]` sequence collapses to `add X`, which pass 1 then
 *   converts to `update X` if X was already in KB — clean in-place
 *   replacement. A `[add X, remove X]` cancellation collapses to
 *   `remove X` (dropped by pass 1 if X isn't in KB; otherwise emits a
 *   single delete). All cases produce ≤ 1 hunk per item, sidestepping
 *   the handler's anchor-conflict failure mode.
 *
 * Pure function; caller (`c-fix-runner`) supplies the KB file snapshot + the
 * manifest field name as `fieldLabel`.
 */
export function cFixInventory(
    deltas: readonly InventoryDelta[],
    fileContent: string,
    fieldLabel: string,
): InventoryCFixResult {
    if (deltas.length === 0) return { deltas: [], fixes: [] };

    const lines = fileContent.split('\n');
    const fixes: AutoFixLog[] = [];

    // Pass 1: reconcile each delta with KB state.
    const intermediate: InventoryDelta[] = [];
    for (const delta of deltas) {
        if (!delta.item) {
            // Empty item name — drop. Pass 2 needs a non-empty key so this
            // also avoids a degenerate `seen` entry. Handler-side would no-op
            // on this anyway; logging here keeps the trace accurate.
            fixes.push({
                domain: 'inventory',
                kind: 'dropped-empty-item',
                reason: `${fieldLabel} — ${delta.op} with empty item name`,
            });
            continue;
        }
        const existing = findItemLine(lines, delta.item);
        if (delta.op === 'remove' && !existing) {
            fixes.push({
                domain: 'inventory',
                kind: 'dropped-missing-remove',
                reason: `${fieldLabel} — remove "${delta.item}": item not in slot`,
            });
            continue;
        }
        if (delta.op === 'update' && !existing) {
            fixes.push({
                domain: 'inventory',
                kind: 'update-fallback-to-add',
                reason: `${fieldLabel} — update "${delta.item}": item not in slot, converted to add`,
            });
            intermediate.push({ ...delta, op: 'add' });
            continue;
        }
        if (delta.op === 'add' && existing) {
            fixes.push({
                domain: 'inventory',
                kind: 'add-merged-to-update',
                reason: `${fieldLabel} — add "${delta.item}": item already in slot, converted to update`,
            });
            intermediate.push({ ...delta, op: 'update' });
            continue;
        }
        intermediate.push(delta);
    }

    // Pass 2: same-item dedupe, keep last regardless of op.
    //
    // Pre-compute last-index per item so the second loop can drop earlier
    // occurrences in a single pass — O(N) instead of O(N²) splicing.
    const lastIndex = new Map<string, number>();
    intermediate.forEach((delta, i) => lastIndex.set(delta.item, i));
    const out: InventoryDelta[] = [];
    intermediate.forEach((delta, i) => {
        if (lastIndex.get(delta.item) !== i) {
            fixes.push({
                domain: 'inventory',
                kind: 'dropped-stale-dup-item',
                reason: `${fieldLabel} — ${delta.op} "${delta.item}": dropped (later op on same item supersedes; handler would otherwise anchor-conflict)`,
            });
            return;
        }
        out.push(delta);
    });

    return { deltas: out, fixes };
}
