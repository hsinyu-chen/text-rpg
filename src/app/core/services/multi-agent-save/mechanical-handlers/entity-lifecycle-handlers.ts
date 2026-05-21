import type { FileUpdate } from '../../file-update.types';
import type { CharacterCreate, EntityDelete, EntityMove } from '../multi-agent-save.types';
import { opsToFileUpdates, type SaveUpdateOp } from '../utils/file-update-ops.util';
import { lookupSectionBlock, pushToMap, stripHeadingPrefix } from '../utils/handler-helpers.util';
import type { MechanicalHandlerContext } from './protagonist-handlers';

/**
 * Lifecycle handlers shared by `charactersTo{Create,Delete,Move}` and the
 * `factionsTo{...}` mirror. Character and faction entries are L2 headings
 * under L1 group headings (e.g. `# 核心人物 > ## 李四`) in BOTH KB files, so a
 * single set of helpers serves both — the registry just routes by
 * `ctx.targetFile`.
 *
 * Failure semantics: handler-side issues (entity not found, unresolved
 * breadcrumb path, empty drafted fields) are dropped silently. The dispatcher
 * reads an empty result as `empty_section`; manifest-level audits are
 * SaveAgent's job.
 */

/**
 * Emits one append `FileUpdate` per L1 group containing each new entity's full
 * markdown body. Same-group creates collapse into one hunk so the trace stays
 * compact.
 */
export function createEntities(
    creates: readonly CharacterCreate[],
    ctx: MechanicalHandlerContext,
): FileUpdate[] {
    if (creates.length === 0) return [];

    const grouped = new Map<string, SaveUpdateOp[]>();
    for (const c of creates) {
        if (!c.name || !c.group) continue;
        const body = renderEntityBody(c);
        if (!body) continue;
        // `# {group}` is the breadcrumb context the matcher expects.
        // {@link stripHeadingPrefix} guards against the model returning the
        // group text WITH a leading `#` (the schema describes it as bare
        // text, but local models drift).
        const ctxPath = `# ${stripHeadingPrefix(c.group)}`;
        pushToMap(grouped, ctxPath, { kind: 'append', replacement: body });
    }

    if (grouped.size === 0) return [];
    return [...grouped.entries()]
        .flatMap(([groupPath, ops]) => opsToFileUpdates(ctx.targetFile, groupPath, ops));
}

/**
 * For each delete, looks up the L2 entity block by its model-supplied
 * `sectionPath` breadcrumb (`# 核心人物 > ## 李四`) and emits a delete hunk on
 * that block. Multi-level breadcrumbs disambiguate same-name entities across
 * L1 groups; an unresolved path (typo, stale name, deleted upstream) drops
 * the op silently. The `reason` field lands in the trace only, never in the
 * emitted hunk.
 */
export function deleteEntities(
    deletes: readonly EntityDelete[],
    ctx: MechanicalHandlerContext,
): FileUpdate[] {
    if (deletes.length === 0) return [];
    const lines = ctx.fileContent.split('\n');
    const ops: SaveUpdateOp[] = [];
    for (const d of deletes) {
        const block = lookupSectionBlock(ctx.fileContent, lines, d.sectionPath);
        if (block) {
            ops.push({ kind: 'delete', target: block });
        }
    }
    if (ops.length === 0) return [];
    return opsToFileUpdates(ctx.targetFile, '', ops);
}

/**
 * Move = delete the original L2 block at `fromSectionPath` + append a copy of
 * it under the target L1 group. Emits the delete with empty context and each
 * append under its `# {toGroup}` context. Drops the move silently when
 * `fromSectionPath` does not resolve in the current file.
 */
export function moveEntities(
    moves: readonly EntityMove[],
    ctx: MechanicalHandlerContext,
): FileUpdate[] {
    if (moves.length === 0) return [];
    const lines = ctx.fileContent.split('\n');

    const deleteOps: SaveUpdateOp[] = [];
    const appendsByGroup = new Map<string, SaveUpdateOp[]>();
    for (const m of moves) {
        if (!m.toGroup) continue;
        const block = lookupSectionBlock(ctx.fileContent, lines, m.fromSectionPath);
        if (!block) continue;
        deleteOps.push({ kind: 'delete', target: block });
        const ctxPath = `# ${stripHeadingPrefix(m.toGroup)}`;
        // Leading newline mirrors `renderEntityBody`'s output so consecutive
        // moves into the same target group don't smash heading lines together
        // (`## 李四\n…- 劍士\n## 王五` with no blank line).
        pushToMap(appendsByGroup, ctxPath, { kind: 'append', replacement: `\n${block}` });
    }

    const deletes = opsToFileUpdates(ctx.targetFile, '', deleteOps);
    const appends = [...appendsByGroup.entries()]
        .flatMap(([groupPath, ops]) => opsToFileUpdates(ctx.targetFile, groupPath, ops));
    return [...deletes, ...appends];
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
    // `renderPlanBlock`'s shape. `stripHeadingPrefix` defends against model
    // output that includes the `## ` prefix in `c.name` itself.
    return `\n## ${stripHeadingPrefix(c.name)}\n\n${fieldLines}`;
}
