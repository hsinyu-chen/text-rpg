import type { InventoryDelta } from '../multi-agent-save.types';
import { saveBlock, type SaveUpdateOp } from '../utils/serialize-save-block.util';

/**
 * Context passed to every mechanical handler — the dispatcher's job to
 * assemble. Handlers should NOT inject services; they're pure functions so
 * specs can drive them with literal fixtures.
 */
export interface MechanicalHandlerContext {
    /**
     * Filename of the KB file this handler should target. The dispatcher
     * resolves the right filename from the active locale's `coreFilenames`
     * before invoking, so handlers stay locale-agnostic.
     */
    targetFile: string;
    /**
     * Current contents of the target file. Used for "find the existing item
     * line" lookups on `remove` / `update`. May be `''` when the file is new
     * (the file-creation case is handled by `add` → append).
     */
    fileContent: string;
}

/**
 * Translates `inventoryDeltas` (or the structurally-identical `assetsDeltas`)
 * into a single `<save>` XML block containing one `<update>` per delta.
 *
 * Strategy:
 * - **`add`**: append `- {item}` (or `- {item} — {details}` when `details`
 *   is provided) to the file. `context=""` so FileUpdateParser appends at
 *   file root — the inventory file has no nested headings worth aiming at
 *   for Phase 1.
 * - **`remove`**: scan the file for a line that contains the item name
 *   (substring match, case-sensitive). If found, emit a `delete` op with
 *   that exact line. If not found, the delta is silently dropped — the
 *   caller's audit list captures it.
 * - **`update`**: same line-lookup as `remove`. If found, emit a `replace`
 *   op with `details` (or just the item name) as the new line content. If
 *   not found, fall back to `add` semantics — append the new line as a new
 *   item, since the LLM clearly thinks this item should exist post-ACT.
 *
 * Returns `''` when every delta was dropped, so the dispatcher can decide
 * whether to mark the entry as `done` (some XML emitted) or `skipped`
 * (`empty_section`).
 */
export function applyInventoryDeltas(deltas: readonly InventoryDelta[], ctx: MechanicalHandlerContext): string {
    if (deltas.length === 0) return '';

    const ops: SaveUpdateOp[] = [];
    for (const delta of deltas) {
        switch (delta.op) {
            case 'add': {
                ops.push({ kind: 'append', replacement: '\n' + formatItemLine(delta) });
                break;
            }
            case 'remove': {
                const existing = findItemLine(ctx.fileContent, delta.item);
                if (existing) {
                    // Trailing newline included so the deletion doesn't leave a
                    // blank line behind — FileUpdateParser does whitespace-
                    // sensitive matching, so the line + its terminator come out
                    // together.
                    ops.push({ kind: 'delete', target: existing });
                }
                break;
            }
            case 'update': {
                const existing = findItemLine(ctx.fileContent, delta.item);
                if (existing) {
                    ops.push({ kind: 'replace', target: existing, replacement: formatItemLine(delta) });
                } else {
                    // The model thinks the item should exist post-ACT but it's
                    // not in the current file — treat as an add. Safer than
                    // emitting a stale target that won't match.
                    ops.push({ kind: 'append', replacement: '\n' + formatItemLine(delta) });
                }
                break;
            }
        }
    }

    return saveBlock(ctx.targetFile, '', ops);
}

function formatItemLine(delta: InventoryDelta): string {
    return delta.details ? `- ${delta.item} — ${delta.details}` : `- ${delta.item}`;
}

/**
 * First line beginning with `- ` whose content contains the item name as a
 * substring. Returns the line including its leading hyphen/space but
 * excluding the trailing newline.
 */
function findItemLine(fileContent: string, itemName: string): string | null {
    if (!itemName) return null;
    for (const line of fileContent.split('\n')) {
        if (line.startsWith('- ') && line.includes(itemName)) {
            return line;
        }
    }
    return null;
}
