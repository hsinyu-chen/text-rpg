/**
 * Pure XML emitters for `<save>` / `<update>` blocks that
 * {@link import('@app/core/services/file-update-parser').FileUpdateParser}
 * consumes.
 *
 * Format mirrors `prompts/source/base/zh-tw/partials/save-xml-format.md`:
 *
 *     <save file="X" context="# Foo > ## Bar">
 *       <update>
 *         <target>...</target>           (optional — omit for append)
 *         <replacement>...</replacement> (optional — omit for delete)
 *       </update>
 *     </save>
 *
 * Multiple ops against the same file+context can share one `<save>` block by
 * stacking `<update>` children — see {@link saveBlock}.
 */

export type SaveUpdateOp =
    | { kind: 'replace'; target: string; replacement: string }
    | { kind: 'append'; replacement: string }
    | { kind: 'delete'; target: string };

/**
 * Wraps one-or-more `<update>` ops in a single `<save>` block.
 *
 * - `file` is the target filename — never escaped (callers must pass a clean
 *   value from the locale's `coreFilenames`; user-supplied paths are not
 *   expected to land here).
 * - `context` is the heading-path breadcrumb (`# Foo > ## Bar`) or the
 *   file-root marker `""`.
 * - The XML attribute encoder escapes `&`, `<`, `>`, `"` defensively even
 *   though `context` is model-generated free text — a stray `"` in a section
 *   path would otherwise break the attribute.
 */
export function saveBlock(file: string, context: string, ops: readonly SaveUpdateOp[]): string {
    if (ops.length === 0) return '';
    // serializeOp may drop ops whose content would corrupt XML (e.g. a
    // literal `</target>` substring); filter the empties so we never emit a
    // childless `<save>...</save>` shell.
    const inner = ops.map(serializeOp).filter(s => s.length > 0).join('\n');
    if (!inner) return '';
    return `<save file="${escapeAttr(file)}" context="${escapeAttr(context)}">\n${inner}\n</save>`;
}

function serializeOp(op: SaveUpdateOp): string {
    // Defensive validation: a literal `</target>` or `</replacement>` in op
    // content would close the wrapping tag early and corrupt the XML stream.
    // FileUpdateParser doesn't decode entities (intentional — see comment
    // below), and the legacy LLM-emitted save path has the same constraint,
    // so this is a content invariant the handler must enforce. Skip the op
    // (return empty) rather than emit broken XML; the dispatcher's
    // progress entry will surface as `done` with shorter output.
    if (containsClosingTag(op)) return '';

    switch (op.kind) {
        case 'replace':
            return `  <update>\n    <target>${op.target}</target>\n    <replacement>${op.replacement}</replacement>\n  </update>`;
        case 'append':
            return `  <update>\n    <replacement>${op.replacement}</replacement>\n  </update>`;
        case 'delete':
            return `  <update>\n    <target>${op.target}</target>\n    <replacement></replacement>\n  </update>`;
    }
}

const CLOSING_TAG_RE = /<\/(target|replacement)>/i;
function containsClosingTag(op: SaveUpdateOp): boolean {
    if ('target' in op && CLOSING_TAG_RE.test(op.target)) return true;
    if ('replacement' in op && CLOSING_TAG_RE.test(op.replacement)) return true;
    return false;
}

function escapeAttr(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// NOTE: We do NOT escape `<` / `&` inside <target> / <replacement>.
// `FileUpdateParser.parse` doesn't decode entities, so any escape here would
// be persisted *as literal text* into the KB file (e.g. "Salt & Pepper" →
// "Salt &amp; Pepper" on disk). Real model output rarely contains literal
// `</target>` / `</replacement>` tags inside save payloads; the legacy save
// path runs unescaped through the same parser and that's been stable.
