import type { InventoryDelta, PlanDelta } from '../multi-agent-save.types';
import { saveBlock, type SaveUpdateOp } from '../utils/serialize-save-block.util';
import { lookupSectionBlock } from '../utils/handler-helpers.util';

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
    /**
     * Locale-specific KB section heading texts the dispatcher needs to pin
     * `<save context="…">` to (e.g. the Story Outline chronicle heading
     * differs zh `劇情綱要` vs en `Story Outline`). Threaded from
     * {@link import('@app/core/constants/locales/locale.interface').AppLocale.kbSectionHeadings}
     * by the dispatcher.
     */
    kbSectionHeadings: {
        STORY_OUTLINE_CHRONICLE: string;
    };
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
 * - **`remove`**: scan the file for a list-item line whose body starts with
 *   the item name (anchored match — see {@link findItemLine}). If found,
 *   emit a `delete` op with that exact line. If not found, the delta is
 *   silently dropped — the caller's audit list captures it.
 * - **`update`**: same anchored line-lookup as `remove`. If found, emit a
 *   `replace` op with `details` (or just the item name) as the new line
 *   content. If not found, fall back to `add` semantics — append the new
 *   line as a new item, since the LLM clearly thinks this item should
 *   exist post-ACT.
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
    // Leading newline before appended items separates them from existing
    // content. Empty file (first entry creating the inventory list) doesn't
    // need one — would otherwise leave a stray blank line at file head.
    const appendPrefix = ctx.fileContent.length > 0 ? '\n' : '';
    const ops: SaveUpdateOp[] = [];
    for (const delta of deltas) {
        switch (delta.op) {
            case 'add': {
                ops.push({ kind: 'append', replacement: appendPrefix + formatItemLine(delta) });
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
                    // Mirror the target's leading indent on the replacement
                    // as an explicit contract — what the handler emits
                    // matches what the file column expects.
                    //
                    // Strictly speaking this is belt-and-suspenders today:
                    // FileUpdateParser.dedent() strips the leading
                    // whitespace from <replacement> at parse time, and
                    // file-update.service's aware-vs-lazy heuristic
                    // re-indents the bare replacement to file column for
                    // single-line ops. So apply-time the user sees the
                    // right thing even without this prefix. The explicit
                    // emission still wins on:
                    //   - readability of the resulting <save> XML
                    //   - robustness if the apply heuristic ever changes
                    //   - multi-line replacements (a future op shape)
                    //     where dedent would NOT strip per-line indent.
                    const indent = existing.match(/^\s*/)?.[0] ?? '';
                    ops.push({ kind: 'replace', target: existing, replacement: indent + formatItemLine(delta) });
                } else {
                    // The model thinks the item should exist post-ACT but it's
                    // not in the current file — treat as an add. Safer than
                    // emitting a stale target that won't match.
                    ops.push({ kind: 'append', replacement: appendPrefix + formatItemLine(delta) });
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
        // CommonMark / GFM unordered list markers — `-`, `*`, and `+` all
        // valid. The LLM almost always emits `-` for zh-tw content, but
        // user-edited KBs or legacy data may use any. Strip the marker
        // before anchored-matching the item name.
        const markerMatch = trimmed.match(/^([-*+])\s/);
        if (!markerMatch) continue;
        // After the leading `<marker> `, the next chars must BE the item
        // name, and what follows must be a separator or end-of-string. e.g.
        //   `- 短刀`            → match for item="短刀"
        //   `- 短刀 — desc`     → match for item="短刀"
        //   `- 短刀（藍刃）`    → match for item="短刀" (Chinese paren boundary)
        //   `- 短刀子`          → NO match for item="短刀"
        const afterMarker = trimmed.slice(markerMatch[0].length);
        if (!afterMarker.startsWith(itemName)) continue;
        const next = afterMarker.charAt(itemName.length);
        if (next === '' || ITEM_BOUNDARY_RE.test(next)) {
            return line;
        }
    }
    return null;
}

/**
 * Characters that legally terminate an item-name token in our handler's
 * eyes. Covers ASCII separators (space, hyphen, colon, paren, comma,
 * semicolon, bang, question, close brackets) plus the Chinese full-width
 * variants the LLM often emits (`：`, `（`, `，`, `；`, `。`, `！`, `？`,
 * close brackets, etc.). zh-tw is the primary content language so the
 * Chinese variants are not edge cases.
 *
 * Note: ASCII `.` is deliberately excluded. Item names routinely contain
 * literal dots — version numbers ("v1.0"), file extensions, abbreviations
 * — so treating `.` as a boundary would let `item="v1"` falsely anchor on
 * `- v1.0`. Chinese `。` stays in because it's a sentence terminator and
 * almost never appears mid-name.
 */
const ITEM_BOUNDARY_RE = /[\s\-—:：(（［【「,，;；。!！?？\]】}｝)）]/;

/**
 * Translates `plansDeltas` into `<save>` XML for the Plans KB file. Plans live
 * as `## 「{title}」計畫` L2 blocks (per the template in `8.計畫.md`); the
 * handler owns the heading wrapping so SaveAgent's `title` is just the plan
 * name, no brackets / suffix.
 *
 * Strategy mirrors {@link applyInventoryDeltas} but at the section level:
 * - **`add`**: append `\n## 「{title}」計畫\n\n{body}` at file root.
 * - **`remove`**: look up the L2 block via {@link lookupSectionBlock};
 *   emit a delete on the verbatim block text. Ambiguous (multiple matches)
 *   or missing → silently drop.
 * - **`update`**: same look-up; emit a replace from the existing block to the
 *   rewrapped new body. Missing → fall back to `add` (SaveAgent clearly
 *   thinks this plan should exist post-ACT).
 *
 * `body` may be omitted on `remove` (ignored anyway) and empty on
 * `add` / `update` — an empty body still produces a valid heading-only entry.
 *
 * **Locale gotcha**: the `「…」計畫` heading wrap is zh-tw-specific (the blank
 * world template for zh ships `8.計畫.md`; the en blank world template does
 * not ship a Plans file yet). When en plans land, this wrap will move into
 * AppLocale alongside `kbSectionHeadings`.
 */
export function applyPlansDeltas(deltas: readonly PlanDelta[], ctx: MechanicalHandlerContext): string {
    if (deltas.length === 0) return '';

    const lines = ctx.fileContent.split('\n');
    const appendPrefix = ctx.fileContent.length > 0 ? '\n' : '';
    const ops: SaveUpdateOp[] = [];
    for (const delta of deltas) {
        if (!delta.title) continue;
        const heading = `「${delta.title}」計畫`;
        switch (delta.op) {
            case 'add': {
                ops.push({ kind: 'append', replacement: appendPrefix + renderPlanBlock(heading, delta.body) });
                break;
            }
            case 'remove': {
                const block = lookupPlanBlock(ctx.fileContent, lines, heading);
                if (block) {
                    ops.push({ kind: 'delete', target: block });
                }
                break;
            }
            case 'update': {
                const block = lookupPlanBlock(ctx.fileContent, lines, heading);
                if (block) {
                    ops.push({ kind: 'replace', target: block, replacement: renderPlanBlock(heading, delta.body) });
                } else {
                    ops.push({ kind: 'append', replacement: appendPrefix + renderPlanBlock(heading, delta.body) });
                }
                break;
            }
        }
    }
    return saveBlock(ctx.targetFile, '', ops);
}

function renderPlanBlock(heading: string, body: string | undefined): string {
    const trimmedBody = (body ?? '').trim();
    return trimmedBody ? `## ${heading}\n\n${trimmedBody}` : `## ${heading}`;
}

function lookupPlanBlock(content: string, lines: readonly string[], heading: string): string | null {
    return lookupSectionBlock(content, lines, `## ${heading}`);
}
