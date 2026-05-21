import type { FileUpdate } from '../../file-update.types';

/**
 * Internal op shape used by mechanical handlers to express section edits as
 * a uniform list before emit. Each handler builds `SaveUpdateOp[]` (with
 * grouping / dedup of its own) and hands them to {@link opsToFileUpdates}
 * for the final {@link FileUpdate} mapping the dispatcher consumes.
 *
 * `delete` is a `replace` whose `replacementContent` is the empty string.
 * `append` is a hunk with no `targetContent`. Kept as separate variants here
 * because handler code reads more cleanly that way and the conversion is
 * one switch.
 */
export type SaveUpdateOp =
    | { kind: 'replace'; target: string; replacement: string }
    | { kind: 'append'; replacement: string }
    | { kind: 'delete'; target: string };

/**
 * Maps a handler's `SaveUpdateOp[]` to `FileUpdate[]` rows pinned to a single
 * file + heading context. Each op becomes one hunk:
 *
 * - `replace { target, replacement }` → `{ targetContent: target, replacementContent: replacement }`
 * - `append { replacement }` → `{ replacementContent: replacement }` (no `targetContent` ≡ append at section end)
 * - `delete { target }` → `{ targetContent: target, replacementContent: '' }`
 *
 * `context` is the heading breadcrumb (`# Foo > ## Bar`) the AutoUpdateDialog's
 * matcher pins on; pass `''` for file-root operations.
 *
 * For the `append` path, leading / trailing blank lines on the replacement
 * are stripped — mirrors the legacy `FileUpdateParser.dedent` step that used
 * to run on the XML wire. The append branch in `FileUpdateService.applyUpdateToFile`
 * splits the replacement on `\r?\n` and splices each element into the file's
 * line array, so a handler-emitted leading `\n` would otherwise land as an
 * extra blank line in the file. Handlers historically emit `\n` as an
 * in-block separator marker — splice adds the actual line break implicitly.
 */
export function opsToFileUpdates(
    file: string,
    context: string,
    ops: readonly SaveUpdateOp[],
): FileUpdate[] {
    return ops.map(op => opToFileUpdate(file, context, op));
}

function opToFileUpdate(file: string, context: string, op: SaveUpdateOp): FileUpdate {
    switch (op.kind) {
        case 'replace':
            return { filePath: file, context, targetContent: op.target, replacementContent: op.replacement };
        case 'append':
            return { filePath: file, context, replacementContent: stripWrappingBlankLines(op.replacement) };
        case 'delete':
            return { filePath: file, context, targetContent: op.target, replacementContent: '' };
    }
}

/**
 * Removes leading + trailing whitespace-only lines from `content`. Common
 * indent is NOT stripped (unlike full `dedent`) — append content is taken
 * verbatim by the apply step, so any indent the handler chose must survive
 * intact.
 */
function stripWrappingBlankLines(content: string): string {
    if (!content) return content;
    const lines = content.split(/\r?\n/);
    while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
    return lines.join('\n');
}
