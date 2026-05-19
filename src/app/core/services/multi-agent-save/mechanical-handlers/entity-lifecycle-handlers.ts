import type { CharacterCreate, EntityDelete, EntityMove } from '../multi-agent-save.types';
import { saveBlock, type SaveUpdateOp } from '../utils/serialize-save-block.util';
import { lookupSectionBlock, pushToMap } from '../utils/handler-helpers.util';
import type { MechanicalHandlerContext } from './protagonist-handlers';

/**
 * Lifecycle handlers shared by `charactersTo{Create,Delete,Move}` and the
 * `factionsTo{...}` mirror. Character and faction entries are L2 headings
 * under L1 group headings (e.g. `# 核心人物 > ## 李四`) in BOTH KB files, so a
 * single set of helpers serves both — the registry just routes by
 * `ctx.targetFile`.
 *
 * Failure semantics: handler-side issues (entity not found, ambiguous name,
 * empty drafted fields) are dropped silently. The dispatcher reads an empty
 * XML return as `empty_section`; manifest-level audits are SaveAgent's job.
 */

/**
 * Emits one `<save>` block per L1 group containing append-replacements for
 * each new entity's full markdown body. Same-group creates collapse into one
 * block so the dispatcher trace stays compact.
 */
export function createEntities(
    creates: readonly CharacterCreate[],
    ctx: MechanicalHandlerContext,
): string {
    if (creates.length === 0) return '';

    const grouped = new Map<string, SaveUpdateOp[]>();
    for (const c of creates) {
        if (!c.name || !c.group) continue;
        const body = renderEntityBody(c);
        if (!body) continue;
        // `# {group}` is the breadcrumb context the FileUpdateParser expects.
        // We don't strip an existing `#` prefix from the model output — the
        // schema describes `group` as "L1 group heading text verbatim" which
        // means the text WITHOUT the leading `#`.
        const ctxPath = `# ${c.group}`;
        pushToMap(grouped, ctxPath, { kind: 'append', replacement: body });
    }

    if (grouped.size === 0) return '';
    return [...grouped.entries()]
        .map(([groupPath, ops]) => saveBlock(ctx.targetFile, groupPath, ops))
        .filter(s => s.length > 0)
        .join('\n');
}

/**
 * For each delete, finds the entity's L2 block via {@link lookupSectionBlock}
 * and emits a delete op on that block. Ambiguous matches (same name under
 * different L1 groups) are dropped — Phase 1 doesn't disambiguate. The
 * `reason` field lands in the trace only, never in the emitted XML.
 */
export function deleteEntities(
    deletes: readonly EntityDelete[],
    ctx: MechanicalHandlerContext,
): string {
    if (deletes.length === 0) return '';
    const lines = ctx.fileContent.split('\n');
    const ops: SaveUpdateOp[] = [];
    for (const d of deletes) {
        const block = lookupEntityBlock(ctx.fileContent, lines, d.name);
        if (block) {
            ops.push({ kind: 'delete', target: block });
        }
    }
    if (ops.length === 0) return '';
    return saveBlock(ctx.targetFile, '', ops);
}

/**
 * Move = delete the original L2 block + append a copy of it under the target
 * L1 group. Emits the delete in a root-context `<save>` and the append in a
 * `# {toGroup}` context block. Drops the move silently when the entity isn't
 * found or matches ambiguously.
 */
export function moveEntities(
    moves: readonly EntityMove[],
    ctx: MechanicalHandlerContext,
): string {
    if (moves.length === 0) return '';
    const lines = ctx.fileContent.split('\n');

    const deleteOps: SaveUpdateOp[] = [];
    const appendsByGroup = new Map<string, SaveUpdateOp[]>();
    for (const m of moves) {
        if (!m.toGroup) continue;
        const block = lookupEntityBlock(ctx.fileContent, lines, m.name);
        if (!block) continue;
        deleteOps.push({ kind: 'delete', target: block });
        const ctxPath = `# ${m.toGroup}`;
        // Leading newline mirrors `renderEntityBody`'s output so consecutive
        // moves into the same target group don't smash heading lines together
        // (`## 李四\n…- 劍士\n## 王五` with no blank line). FileUpdateParser's
        // dedent strips it back off the <target> path but preserves it on
        // appends, which is exactly what we want here.
        pushToMap(appendsByGroup, ctxPath, { kind: 'append', replacement: `\n${block}` });
    }

    const parts: string[] = [];
    if (deleteOps.length > 0) {
        const deleteBlock = saveBlock(ctx.targetFile, '', deleteOps);
        if (deleteBlock) parts.push(deleteBlock);
    }
    for (const [groupPath, ops] of appendsByGroup) {
        const block = saveBlock(ctx.targetFile, groupPath, ops);
        if (block) parts.push(block);
    }
    return parts.join('\n');
}

/**
 * `## {name}` look-up wrapper around the shared {@link lookupSectionBlock}
 * helper — handler-local because the heading prefix is fixed at L2 for
 * character / faction entries and the caller passes only the bare name.
 */
function lookupEntityBlock(content: string, lines: readonly string[], name: string): string | null {
    if (!name) return null;
    return lookupSectionBlock(content, lines, `## ${name}`);
}

/**
 * Renders an entity entry markdown body from its drafted fields. Format
 * follows the demo-world / blank-world templates:
 *
 *     ## {name}
 *
 *     - **field1**: value1
 *     - **field2**: value2
 *
 * Returns '' when `draftedFields` is empty — a heading-only entry has no
 * useful information for the KB.
 */
function renderEntityBody(c: CharacterCreate): string {
    const entries = Object.entries(c.draftedFields ?? {});
    if (entries.length === 0) return '';
    const fieldLines = entries.map(([k, v]) => `- **${k}**: ${v}`).join('\n');
    // Leading `\n` provides the blank-line separator between this entry and
    // the preceding section content; no trailing `\n` because the NEXT entry
    // (or another append) brings its own leading `\n`, and trailing here would
    // stack a second blank line on every append boundary. Mirrors
    // `renderPlanBlock`'s shape.
    return `\n## ${c.name}\n\n${fieldLines}`;
}

