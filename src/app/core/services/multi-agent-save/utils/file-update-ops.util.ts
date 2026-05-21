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
 * matcher pins on; pass `''` for file-root operations (mirrors the legacy
 * `<save context="">` form).
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
            return { filePath: file, context, replacementContent: op.replacement };
        case 'delete':
            return { filePath: file, context, targetContent: op.target, replacementContent: '' };
    }
}
