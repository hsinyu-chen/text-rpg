import type { Schema } from '@app/core/models/types';
import type { SaveHunk } from '../multi-agent-save.types';
import { withHunkIds, type NewHunk } from '../utils/hunk-id.util';

/**
 * Structured-output schema for the SaveAgent manifest: a flat array of
 * {@link SaveHunk}. The model writes `target` / `replacement` as finished
 * markdown — no TypeScript layer renders structured fields — so this schema
 * stays small and format-agnostic.
 *
 * Kept inline (no `$ref` indirection) — providers vary in how they resolve
 * `$ref`, and the hunk shape is small enough that inlining wins on clarity.
 */
const hunkItem = {
    type: 'object',
    required: ['file', 'context', 'replacement'],
    properties: {
        file: {
            type: 'string',
            description: 'Target KB filename (the locale-resolved actual name as it appears in the provided files).',
        },
        context: {
            type: 'array',
            items: { type: 'string' },
            description: "Heading breadcrumb crumbs (outermost → innermost) locating the edit, e.g. ['Section', 'Subsection']. Each element is the heading's raw text only — no '#' prefix, no separators. Empty array targets the file root.",
        },
        target: {
            type: 'string',
            description: 'Exact existing text to replace or delete, copied verbatim from the file. Omit to append the replacement at the end of the context section.',
        },
        replacement: {
            type: 'string',
            description: 'New content as finished markdown. Empty string together with a target means "delete the target".',
        },
        sourceMessageIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'ChatMessage.id values from the current ACT that grounded this hunk. Omit when the hunk is an inference without direct message evidence; emit [] to explicitly mark "no anchors".',
        },
    },
} as const;

/**
 * SaveAgent manifest schema — the model emits a JSON array of hunks directly,
 * no wrapping object.
 */
export const SAVE_MANIFEST_SCHEMA: Schema = {
    type: 'array',
    description: 'SaveAgent manifest — a flat list of verbatim KB edits (hunks).',
    items: hunkItem,
};

/**
 * Runtime validation result. Provider structured-output mostly enforces the
 * shape upstream, but local llama.cpp and some cloud providers can return
 * malformed JSON under load — every parsed manifest goes through this.
 */
export type ManifestValidationResult =
    | { ok: true; hunks: SaveHunk[] }
    | { ok: false; error: string };

/**
 * Validates a parsed JSON value as a `SaveHunk[]` manifest. Structural shape
 * only — required fields and types; does not inspect markdown content.
 *
 * Salvages the valid prefix on a malformed tail: a `MAX_TOKENS` truncation
 * corrupts only the last hunk, and hunks are independent, so dropping the
 * truncated tail keeps a near-complete manifest usable (the orchestrator's
 * `finishReason` warning still flags the result as partial). A malformed
 * `hunk[0]` means the output is broken outright, not truncated — hard-fail.
 *
 * The validated hunks are stamped with framework ids (`H1` / `H2` …) — the
 * LLM emits id-less objects (`SAVE_MANIFEST_SCHEMA` has no `id`), this is the
 * single canonical site that turns parsed JSON into a stable {@link SaveHunk}.
 */
export function validateManifest(value: unknown): ManifestValidationResult {
    if (!Array.isArray(value)) return { ok: false, error: 'manifest is not an array' };

    const raw: NewHunk[] = [];
    for (let i = 0; i < value.length; i++) {
        const err = validateHunk(value[i], i);
        if (err) {
            if (i === 0) return { ok: false, error: err };
            break;
        }
        raw.push(value[i] as NewHunk);
    }
    return { ok: true, hunks: withHunkIds(raw) };
}

/** Structural check for one hunk; returns an error string or `null` if valid. */
function validateHunk(h: unknown, i: number): string | null {
    if (!isObject(h)) return `hunk[${i}] is not an object`;
    if (typeof h['file'] !== 'string') return `hunk[${i}].file missing`;
    if (!isStringArray(h['context'])) return `hunk[${i}].context must be string[]`;
    if (typeof h['replacement'] !== 'string') return `hunk[${i}].replacement missing`;
    const target = h['target'];
    if (target !== undefined && typeof target !== 'string') return `hunk[${i}].target must be string`;
    const ids = h['sourceMessageIds'];
    if (ids !== undefined && !isStringArray(ids)) return `hunk[${i}].sourceMessageIds must be string[]`;
    return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every(x => typeof x === 'string');
}
