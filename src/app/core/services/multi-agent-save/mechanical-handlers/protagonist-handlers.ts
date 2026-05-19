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

    // Split once up-front so a manifest with N deltas does one pass over the
    // file instead of N. Inventory files in real KBs sit around ~50-200 lines;
    // the wasted work is small but the fix is free.
    const lines = ctx.fileContent.split('\n');
    const ops: SaveUpdateOp[] = [];
    for (const delta of deltas) {
        switch (delta.op) {
            case 'add': {
                ops.push({ kind: 'append', replacement: '\n' + formatItemLine(delta) });
                break;
            }
            case 'remove': {
                const existing = findItemLine(lines, delta.item);
                if (existing) {
                    // FileUpdateParser.dedent strips the leading/trailing
                    // blank lines off <target>, so we can't actually send
                    // "line + newline" as the apply-time target. Consecutive
                    // removes may therefore leave one blank line per deletion;
                    // AutoUpdateDialog surfaces the resulting diff for user
                    // approval, so a stray blank isn't catastrophic.
                    ops.push({ kind: 'delete', target: existing });
                }
                break;
            }
            case 'update': {
                const existing = findItemLine(lines, delta.item);
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
 * First markdown list item line whose body starts with the given item name
 * followed by either a separator (` — ` / `:` / ` (`) or end-of-line.
 * Anchoring rather than naive substring matching avoids two failure modes:
 *
 * 1. `item: "短刀"` accidentally matching `- 短刀（藍刃）` and overwriting
 *    the wrong row on `update` / wrong delete on `remove`.
 * 2. A non-anchored `update` hit short-circuiting the "fall back to append"
 *    branch in {@link applyInventoryDeltas} (the model says "item should
 *    exist post-ACT" but it actually doesn't — we want an add, not an
 *    overwrite of a similarly-named entry).
 *
 * Accepts indented list items (`  - foo`) — common when items live under a
 * category sub-heading. Returns the line verbatim (including any leading
 * indent) so the resulting `<target>` matches the file exactly.
 *
 * Takes a pre-split line array rather than the raw file content so a
 * delta-loop can split once and reuse — see {@link applyInventoryDeltas}.
 */
function findItemLine(lines: readonly string[], itemName: string): string | null {
    if (!itemName) return null;
    for (const line of lines) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith('- ')) continue;
        // After the leading `- `, the next chars must BE the item name, and
        // what follows must be a separator or end-of-string. e.g.
        //   `- 短刀`            → match for item="短刀"
        //   `- 短刀 — desc`     → match for item="短刀"
        //   `- 短刀（藍刃）`    → match for item="短刀" (Chinese paren boundary)
        //   `- 短刀子`          → NO match for item="短刀"
        const afterDash = trimmed.slice(2);
        if (!afterDash.startsWith(itemName)) continue;
        const next = afterDash.charAt(itemName.length);
        if (next === '' || ITEM_BOUNDARY_RE.test(next)) {
            return line;
        }
    }
    return null;
}

/**
 * Characters that legally terminate an item-name token in our handler's
 * eyes. Covers ASCII separators (space, hyphen, colon, paren) plus the
 * Chinese full-width variants the LLM often emits (`：`, `（`, etc.).
 */
const ITEM_BOUNDARY_RE = /[\s\-—:：(（［【「]/;
