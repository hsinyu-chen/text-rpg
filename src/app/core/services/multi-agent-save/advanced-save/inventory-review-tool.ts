import type { LLMFunctionDeclaration } from '@hcs/llm-core';
import type { SaveHunk } from '../multi-agent-save.types';
import { withHunkIds, type NewHunk } from '../utils/hunk-id.util';

/**
 * The terminal commit tool + delta application for {@link
 * import('./inventory-consistency-agent').InventoryConsistencyAgent}.
 *
 * The agent expresses its review as a delta — drop / revise existing
 * inventory hunks, add new tech-equipment hunks — rather than re-emitting the
 * whole manifest: passthrough hunks are never re-serialized by the LLM, so it
 * cannot mangle a hunk it never meant to touch.
 */

/** Stable agent id — also the `enabledSaveAgents` / `saveAgentProfileIds` key. */
export const INVENTORY_CONSISTENCY_AGENT_ID = 'inventory-consistency';

/** Commit-tool name — the agent's terminal action. */
export const COMMIT_INVENTORY_REVIEW = 'commitInventoryReview';

/** Parsed, type-checked `commitInventoryReview` payload. */
export interface CommitInventoryReviewArgs {
    /** Ids of inventory hunks the story does not support — removed outright. */
    dropHunkIds: string[];
    /** Corrected inventory hunks — each carries the existing hunk's `id`. */
    reviseHunks: SaveHunk[];
    /** New tech-equipment detail-setting hunks (id assigned by the framework). */
    newHunks: NewHunk[];
    /** One-line human-readable summary for the progress trace. */
    summary: string;
}

const hunkBodySchema = {
    file: { type: 'string', description: 'Target KB filename, copied verbatim from the hunk list / file list.' },
    context: { type: 'string', description: "Heading breadcrumb, e.g. '# 武器 > ## 玄鐵令'. Empty string targets the file root." },
    target: { type: 'string', description: 'Exact existing text to replace/delete, copied verbatim. Omit to append at the context section end.' },
    replacement: { type: 'string', description: 'New content as finished markdown. Empty + target set = delete.' },
    sourceMessageIds: { type: 'array', items: { type: 'string' }, description: 'Chat message ids that grounded this hunk.' },
} as const;

/** Tool declaration handed to the LLM (native catalog + JSON-schema source). */
export const COMMIT_INVENTORY_REVIEW_TOOL: LLMFunctionDeclaration = {
    name: COMMIT_INVENTORY_REVIEW,
    description: 'Finalize the inventory review. Call this EXACTLY ONCE as your final action. Reports inventory hunks to drop or revise plus any new tech-equipment detail-setting hunks. Pass empty arrays for anything with no change.',
    parameters: {
        type: 'object',
        properties: {
            dropHunkIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Ids (e.g. "H3") of inventory hunks the story does NOT support — hallucinated items or changes that never happened. Copy each id verbatim from the manifest list.',
            },
            reviseHunks: {
                type: 'array',
                description: 'Corrected hunks for (a) an inventory hunk whose item is real but whose details are wrong, or (b) a tech-equipment / world-factions item-setting hunk the main LLM already emitted that you can improve. Each entry MUST carry the original hunk id and keep the same `file` (no relocation). For world-factions: only revise hunks about items / relics / key objects — never touch faction-dynamics or world-event hunks.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'The existing hunk id being corrected, copied verbatim.' },
                        ...hunkBodySchema,
                    },
                    required: ['id', 'file', 'context', 'replacement'],
                },
            },
            newHunks: {
                type: 'array',
                description: 'New detail-setting hunks. Target the tech-equipment file for protagonist-held items, or the world-factions file (key-items / relics scope only — never faction-dynamics) for items the protagonist does NOT hold. Do NOT include an id.',
                items: {
                    type: 'object',
                    properties: { ...hunkBodySchema },
                    required: ['file', 'context', 'replacement'],
                },
            },
            summary: {
                type: 'string',
                description: 'One short sentence describing what this review changed, for the progress trace.',
            },
        },
        required: ['dropHunkIds', 'reviseHunks', 'newHunks', 'summary'],
    },
};

/** Result of applying a review delta — the new hunk list + any skipped-input notes. */
export interface InventoryReviewResult {
    hunks: SaveHunk[];
    /** Inputs the framework refused (out-of-domain file, unknown id) — for logs. */
    warnings: string[];
}

/**
 * Locale-resolved KB filenames the review delta is scoped against. Bundling
 * them keeps `applyInventoryReview`'s positional list manageable as the
 * agent's write scope evolves.
 */
export interface InventoryReviewFiles {
    /** `{{FILE_INVENTORY}}` — carried protagonist items. */
    inventoryFile: string;
    /** `{{FILE_ASSETS}}` — protagonist money / real-estate / stored items. */
    assetsFile: string;
    /** `{{FILE_TECH_EQUIPMENT}}` — physical-item detail settings (PC-held). */
    techEquipmentFile: string;
    /** `{{FILE_WORLD_FACTIONS}}` — non-PC key item / relic settings. */
    worldFactionsFile: string;
}

/**
 * Applies a parsed review delta to the manifest. Enforces the agent's write
 * scope by file:
 *
 * - `dropHunkIds` → inventory or assets (both carry protagonist-property
 *   hunks grounded in `inventory_log`; Job 1's destructive lane).
 * - `reviseHunks` → inventory / assets / tech-equipment / world-factions
 *   (Job 1 + Job 2 overlap-with-main-LLM). For world-factions, the prompt
 *   scopes further to item / relic content — the framework cannot tell
 *   item-setting from faction-dynamics by filename alone.
 * - `newHunks` → tech-equipment (PC-held items) or world-factions (non-PC
 *   key items / relics).
 *
 * Anything outside these scopes is dropped with a warning rather than
 * trusted, so a prompt slip cannot rewrite an unrelated file's hunk.
 */
export function applyInventoryReview(
    hunks: readonly SaveHunk[],
    args: CommitInventoryReviewArgs,
    files: InventoryReviewFiles,
): InventoryReviewResult {
    const { inventoryFile, assetsFile, techEquipmentFile, worldFactionsFile } = files;
    const warnings: string[] = [];
    const byId = new Map(hunks.map(h => [h.id, h]));

    // drop scope: inventory + assets — both are protagonist-property files
    // whose hunks the `inventory_log` digest grounds.
    const dropAllowed = new Set([inventoryFile, assetsFile]);
    const dropped = new Set<string>();
    for (const id of args.dropHunkIds) {
        const h = byId.get(id);
        if (!h) { warnings.push(`drop: unknown hunk id "${id}"`); continue; }
        if (!dropAllowed.has(h.file)) {
            warnings.push(`drop: "${id}" (${h.file}) is outside this agent's drop scope`);
            continue;
        }
        dropped.add(id);
    }

    // revise scope: drop scope (inventory / assets — Job 1 corrections) plus
    // tech-equipment / world-factions (Job 2 overlap with the main LLM's
    // item-setting hunks).
    const reviseAllowed = new Set([inventoryFile, assetsFile, techEquipmentFile, worldFactionsFile]);
    const revised = new Map<string, SaveHunk>();
    for (const r of args.reviseHunks) {
        const h = byId.get(r.id);
        if (!h) { warnings.push(`revise: unknown hunk id "${r.id}"`); continue; }
        if (!reviseAllowed.has(h.file)) {
            warnings.push(`revise: "${r.id}" (${h.file}) is outside this agent's revise scope`);
            continue;
        }
        if (r.file !== h.file) {
            warnings.push(`revise: "${r.id}" cannot move from "${h.file}" to "${r.file}"`);
            continue;
        }
        revised.set(r.id, r);
    }

    // new scope: tech-equipment (PC-held item settings) + world-factions
    // (non-PC key-item settings). Assets is NOT in scope for new — its
    // shape (money / real-estate ledger) doesn't take detail-setting
    // supplements the way TECH / WORLD do.
    const newAllowed = new Set([techEquipmentFile, worldFactionsFile]);
    const accepted: NewHunk[] = [];
    for (const n of args.newHunks) {
        if (!newAllowed.has(n.file)) {
            warnings.push(`new: file "${n.file}" not allowed — new hunks must target "${techEquipmentFile}" or "${worldFactionsFile}"`);
            continue;
        }
        accepted.push(n);
    }

    const kept = hunks
        .filter(h => !dropped.has(h.id))
        .map(h => revised.get(h.id) ?? h);
    // Offset by the original count so appended ids never collide with H1..Hn.
    const stampedNew = withHunkIds(accepted, hunks.length);
    return { hunks: [...kept, ...stampedNew], warnings };
}

/**
 * Defensively parses a raw `commitInventoryReview` args payload. The LLM-shaped
 * `unknown` is coerced field by field; malformed array entries are dropped
 * rather than throwing, so a partly-garbled commit still applies its valid
 * parts (the manifest passthrough is the safe floor anyway).
 */
export function parseCommitArgs(raw: unknown): CommitInventoryReviewArgs {
    const obj = isRecord(raw) ? raw : {};
    return {
        dropHunkIds: asStringArray(obj['dropHunkIds']),
        reviseHunks: asArray(obj['reviseHunks']).map(asSaveHunk).filter(isPresent),
        newHunks: asArray(obj['newHunks']).map(asNewHunk).filter(isPresent),
        summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
    };
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPresent<T>(v: T | null): v is T {
    return v !== null;
}

function asArray(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function asStringArray(v: unknown): string[] {
    return asArray(v).filter((x): x is string => typeof x === 'string');
}

/** Validates the common hunk body; returns the typed fields or null. */
function asHunkBody(v: Record<string, unknown>): NewHunk | null {
    if (typeof v['file'] !== 'string' || typeof v['context'] !== 'string' || typeof v['replacement'] !== 'string') {
        return null;
    }
    const body: NewHunk = { file: v['file'], context: v['context'], replacement: v['replacement'] };
    if (typeof v['target'] === 'string') body.target = v['target'];
    if (Array.isArray(v['sourceMessageIds'])) {
        body.sourceMessageIds = v['sourceMessageIds'].filter((x): x is string => typeof x === 'string');
    }
    return body;
}

function asNewHunk(v: unknown): NewHunk | null {
    return isRecord(v) ? asHunkBody(v) : null;
}

function asSaveHunk(v: unknown): SaveHunk | null {
    if (!isRecord(v) || typeof v['id'] !== 'string') return null;
    const body = asHunkBody(v);
    return body ? { ...body, id: v['id'] } : null;
}
