import type { AutoFixLog, InventoryDelta } from '../multi-agent-save.types';
import { findItemLine } from '../mechanical-handlers/protagonist-handlers';
import { dedupeLastWins } from '../utils/handler-helpers.util';

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
 * Two passes — pass 1 dedupes the LLM's intra-turn batch down to net intent,
 * pass 2 reconciles each surviving op against the KB. Dedup-first matters
 * for intra-turn cancellations like `[add X, remove X]` for an item NOT in
 * the KB: KB-first would drop the `remove` (nothing to remove) and let the
 * `add` go through (phantom addition); dedup-first collapses to `remove X`
 * which KB-reconcile then drops, net = nothing.
 *
 * **Pass 1 — same-item dedupe (keep last, regardless of op):**
 * - The downstream handler anchors every op to the file's *original* state.
 *   If two ops touching the same item both survive, they emit hunks
 *   targeting the same line; FileUpdateService applies them sequentially
 *   and the second one fails ("target not found") — losing the item.
 * - Dedupe strictly by `item`, keep the *last* op.
 *
 * **Pass 2 — per-delta against KB:**
 * 1. `op: 'remove'` for items not in KB → drop (nothing to remove)
 * 2. `op: 'update'` for items not in KB → convert to `add` (the underlying
 *    handler already does this silently; surfacing it in the trace lets the
 *    user see when the LLM's intent diverged from KB state)
 * 3. `op: 'add'` for items already in KB:
 *    - with `details` → convert to `update` so the existing line is replaced
 *      rather than a duplicate appended
 *    - *without* `details` → drop as redundant. Converting to update would
 *      render a bare `- item` line and overwrite any prior description,
 *      silently destroying it. A `details`-less add against an existing
 *      row is null intent ("ensure exists" on a row that does exist).
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

    const fixes: AutoFixLog[] = [];

    // Pass 1: same-item dedupe before KB reconciliation. Empty-item ops are
    // dropped here too so they don't pollute the dedupe key space.
    const nonEmpty: InventoryDelta[] = [];
    for (const delta of deltas) {
        if (!delta.item) {
            fixes.push({
                domain: 'inventory',
                kind: 'dropped-empty-item',
                reason: `${fieldLabel} — ${delta.op} with empty item name`,
            });
            continue;
        }
        nonEmpty.push(delta);
    }
    const intermediate = dedupeLastWins(
        nonEmpty,
        d => d.item,
        d => fixes.push({
            domain: 'inventory',
            kind: 'dropped-stale-dup-item',
            reason: `${fieldLabel} — ${d.op} "${d.item}": dropped (later op on same item supersedes; handler would otherwise anchor-conflict)`,
        }),
    );

    // Pass 2: reconcile each surviving delta with KB state.
    const lines = fileContent.split('\n');
    const out: InventoryDelta[] = [];
    for (const delta of intermediate) {
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
            out.push({ ...delta, op: 'add' });
            continue;
        }
        if (delta.op === 'add' && existing) {
            if (!delta.details) {
                // Convert-to-update would render `- item` and clobber any
                // prior description on the existing row. Drop instead — LLM
                // saying "ensure exists" against an existing row is null intent.
                fixes.push({
                    domain: 'inventory',
                    kind: 'dropped-redundant-add',
                    reason: `${fieldLabel} — add "${delta.item}": item already in slot and no new details supplied; would overwrite existing description`,
                });
                continue;
            }
            fixes.push({
                domain: 'inventory',
                kind: 'add-merged-to-update',
                reason: `${fieldLabel} — add "${delta.item}": item already in slot, converted to update`,
            });
            out.push({ ...delta, op: 'update' });
            continue;
        }
        out.push(delta);
    }

    return { deltas: out, fixes };
}
