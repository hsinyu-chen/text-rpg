import type { AutoFixLog, InventoryDelta } from '../multi-agent-save.types';
import { findItemLine } from '../mechanical-handlers/protagonist-handlers';

export interface InventoryCFixResult {
    deltas: InventoryDelta[];
    fixes: AutoFixLog[];
}

/**
 * Mechanical C-fix for `inventoryDeltas` / `assetsDeltas` (same shape).
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
 * **Pass 2 — same op + same item dedupe (keep last):**
 * - When the LLM repeats `add 玄鐵令` three times in one batch (an observed
 *   real failure mode), the first two are dropped and only the last survives.
 * - Different-op duplicates (e.g. `remove X` + `add X`) are NOT collapsed —
 *   the handler processes deltas in order and the combined effect is a valid
 *   replace-cycle.
 *
 * Pure function; caller (`c-fix-runner`) supplies the KB file snapshot.
 */
export function cFixInventory(
    deltas: readonly InventoryDelta[],
    fileContent: string,
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
                reason: `${delta.op} with empty item name`,
            });
            continue;
        }
        const existing = findItemLine(lines, delta.item);
        if (delta.op === 'remove' && !existing) {
            fixes.push({
                domain: 'inventory',
                kind: 'dropped-missing-remove',
                reason: `remove "${delta.item}" — item not in inventory`,
            });
            continue;
        }
        if (delta.op === 'update' && !existing) {
            fixes.push({
                domain: 'inventory',
                kind: 'update-fallback-to-add',
                reason: `update "${delta.item}" — item not in inventory, converted to add`,
            });
            intermediate.push({ ...delta, op: 'add' });
            continue;
        }
        if (delta.op === 'add' && existing) {
            fixes.push({
                domain: 'inventory',
                kind: 'add-merged-to-update',
                reason: `add "${delta.item}" — item already in inventory, converted to update`,
            });
            intermediate.push({ ...delta, op: 'update' });
            continue;
        }
        intermediate.push(delta);
    }

    // Pass 2: same-op same-item dedupe, keep last.
    //
    // Pre-compute last-index per (op, item) key so the second loop can drop
    // earlier occurrences in a single pass — O(N) instead of O(N²) splicing.
    const lastIndex = new Map<string, number>();
    intermediate.forEach((delta, i) => {
        lastIndex.set(`${delta.op}::${delta.item}`, i);
    });
    const out: InventoryDelta[] = [];
    intermediate.forEach((delta, i) => {
        const key = `${delta.op}::${delta.item}`;
        if (lastIndex.get(key) !== i) {
            fixes.push({
                domain: 'inventory',
                kind: 'dropped-stale-same-op-dup',
                reason: `${delta.op} "${delta.item}" — dropped (later ${delta.op} for same item in batch supersedes)`,
            });
            return;
        }
        out.push(delta);
    });

    return { deltas: out, fixes };
}
