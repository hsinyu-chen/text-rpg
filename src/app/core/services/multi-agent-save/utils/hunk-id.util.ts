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

/**
 * Highest `H<n>` number present in a manifest, or 0 if none. Use this — not
 * `hunks.length` — as the offset when appending new hunks: an earlier stage
 * may have dropped hunks, leaving gaps where `length < max(n)`, so naive
 * length-offset would re-issue an existing id.
 */
export function maxHunkIdNumber(hunks: readonly SaveHunk[]): number {
    let max = 0;
    for (const h of hunks) {
        const m = /^H(\d+)$/.exec(h.id);
        if (m) {
            const n = Number(m[1]);
            if (n > max) max = n;
        }
    }
    return max;
}
