import type { SaveHunk } from '../multi-agent-save.types';

/**
 * A hunk before the framework assigns its `id` — the shape the SaveAgent's
 * JSON output and advanced-save agents author. The framework stamps the id
 * via {@link withHunkIds}; the LLM never writes it.
 */
export type NewHunk = Omit<SaveHunk, 'id'>;

/**
 * Stamps sequential `H1` / `H2` … ids onto id-less hunks. `offset` continues
 * the numbering past an existing manifest so agent-appended hunks never
 * collide with the main manifest's ids.
 *
 * Ids are short on purpose — an LLM references a hunk by copying its printed
 * id verbatim, which it does reliably; computing array positions it does not.
 */
export function withHunkIds(hunks: readonly NewHunk[], offset = 0): SaveHunk[] {
    return hunks.map((h, i) => ({ ...h, id: `H${offset + i + 1}` }));
}
