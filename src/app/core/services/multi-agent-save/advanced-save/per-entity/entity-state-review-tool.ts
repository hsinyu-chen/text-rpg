import type { LLMFunctionDeclaration } from '@hcs/llm-core';
import type { SaveHunk } from '../../multi-agent-save.types';
import { withHunkIds, maxHunkIdNumber, type NewHunk } from '../../utils/hunk-id.util';
import { pruneInvalidSourceMessageIds } from '../../utils/source-message-ids.util';

/**
 * The two terminal tools + delta application shared by both per-entity state
 * agents ({@link import('./character-state-agent').CharacterStateAgent} and
 * {@link import('./faction-state-agent').FactionStateAgent}).
 *
 * One per-entity LLM call ends in exactly one of:
 * - `commitEntityStateReview` — the agent's review delta for THIS entity
 *   (drop / revise existing hunks, add new ones inside the entity's section).
 * - `reportNotAnEntity` — the agent judged this entry to be a provider
 *   compatibility artifact (a format template, a lore footnote the blacklist
 *   missed) rather than a real entity, and declines to touch it.
 *
 * Like the inventory tool, the agent expresses its review as a delta rather
 * than re-emitting the whole manifest, so it can never mangle a passthrough
 * hunk it never meant to touch.
 */

/** Commit-tool name — the agent's terminal "I reviewed this entity" action. */
export const COMMIT_ENTITY_STATE_REVIEW = 'commitEntityStateReview';

/** Skip-tool name — the agent's terminal "this isn't a real entity" action. */
export const REPORT_NOT_AN_ENTITY = 'reportNotAnEntity';

/**
 * LLM self-assessed visibility tier for one delta, recorded for trace
 * diagnosis only — Phase 1 applies no hard gate on it (see the plan's
 * "Perception triage" section). `strong` = directly witnessed this ACT;
 * `medium` = reasonable inference from visible channels; `weak` = a felt
 * direction with no concrete channel.
 */
export type PerceptionLevel = 'strong' | 'medium' | 'weak';

/** A revised hunk plus its optional, trace-only perception annotation. */
export type EntityReviseHunk = SaveHunk & {
    perceptionLevel?: PerceptionLevel;
    perceptionReason?: string;
};

/** A new hunk plus its optional, trace-only perception annotation. */
export type EntityNewHunk = NewHunk & {
    perceptionLevel?: PerceptionLevel;
    perceptionReason?: string;
};

/** Parsed, type-checked `commitEntityStateReview` payload. */
export interface CommitEntityStateReviewArgs {
    /** Ids of this entity's hunks the story does not support — removed outright. */
    dropHunkIds: string[];
    /** Corrected hunks — each carries the existing hunk's `id`. */
    reviseHunks: EntityReviseHunk[];
    /** New hunks inside this entity's section (id assigned by the framework). */
    newHunks: EntityNewHunk[];
    /** One-line human-readable summary for the progress trace. */
    summary: string;
}

/** Parsed, type-checked `reportNotAnEntity` payload. */
export interface ReportNotAnEntityArgs {
    /** The entry name the agent declined — sanity-checked against the seed. */
    entityName: string;
    /** Why it isn't a real entity — recorded in the skip trace. */
    reason: string;
}

const perceptionSchema = {
    perceptionLevel: {
        type: 'string',
        enum: ['strong', 'medium', 'weak'],
        description: "Optional. Your visibility into this change: 'strong' = directly witnessed this ACT, 'medium' = inferred from a visible channel, 'weak' = a felt direction with no concrete channel.",
    },
    perceptionReason: {
        type: 'string',
        description: 'Optional. The visible channel that grounds this change (who saw / reported it, or why it is inferable).',
    },
} as const;

const hunkBodySchema = {
    file: { type: 'string', description: 'Target KB filename, copied verbatim from the hunk list / file list.' },
    context: { type: 'array', items: { type: 'string' }, description: "Heading breadcrumb crumbs (outermost → innermost), e.g. ['核心人物', '露娜 (Luna)', '現況']. Each element is the heading's raw text only — no '#' prefix. Must stay inside THIS entity's section." },
    target: { type: 'string', description: 'Exact existing text to replace/delete, copied verbatim. Omit to append at the context section end.' },
    replacement: { type: 'string', description: 'New content as finished markdown. Empty + target set = delete.' },
    sourceMessageIds: { type: 'array', items: { type: 'string' }, description: 'Chat message ids that grounded this hunk.' },
} as const;

/** Commit tool declaration handed to the LLM (native catalog + JSON-schema source). */
export const COMMIT_ENTITY_STATE_REVIEW_TOOL: LLMFunctionDeclaration = {
    name: COMMIT_ENTITY_STATE_REVIEW,
    description: 'Finalize your review of THIS one entity. Call this EXACTLY ONCE as your final action when the entry is a real entity. Reports its hunks to drop or revise plus any new hunks inside its section. Pass empty arrays for anything with no change.',
    parameters: {
        type: 'object',
        properties: {
            dropHunkIds: {
                type: 'array',
                items: { type: 'string' },
                description: "Ids (e.g. 'H3') of this entity's hunks the story does NOT support — hallucinated changes that never happened. Copy each id verbatim from the hunk list.",
            },
            reviseHunks: {
                type: 'array',
                description: "Corrected hunks for this entity whose change is real but whose details are wrong. Each entry MUST carry the original hunk id and keep the same `file` (no relocation) inside this entity's section.",
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'The existing hunk id being corrected, copied verbatim.' },
                        ...hunkBodySchema,
                        ...perceptionSchema,
                    },
                    required: ['id', 'file', 'context', 'replacement'],
                },
            },
            newHunks: {
                type: 'array',
                description: "New hunks that update fields inside THIS entity's section — facts the SaveAgent missed, or time-elapse evolution (injury recovery, mindset continuation, off-screen plan progress). Do NOT include an id. Do NOT create a brand-new entity entry.",
                items: {
                    type: 'object',
                    properties: { ...hunkBodySchema, ...perceptionSchema },
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

/** Skip tool declaration — the agent's "not a real entity" terminal action. */
export const REPORT_NOT_AN_ENTITY_TOOL: LLMFunctionDeclaration = {
    name: REPORT_NOT_AN_ENTITY,
    description: 'Call this EXACTLY ONCE instead of commitEntityStateReview when the entry handed to you is NOT a real entity — e.g. a format-template placeholder or a lore footnote the provider failed to filter. Use this rather than hallucinating an update for a non-entity.',
    parameters: {
        type: 'object',
        properties: {
            entityName: {
                type: 'string',
                description: 'The entry name you were handed, copied verbatim — a sanity check.',
            },
            reason: {
                type: 'string',
                description: 'Why this entry is not a real entity (e.g. "格式範本 placeholder", "lore footnote").',
            },
        },
        required: ['entityName', 'reason'],
    },
};

/** Result of applying a review delta — the new hunk list + any skipped-input notes. */
export interface EntityStateReviewResult {
    hunks: SaveHunk[];
    /** Inputs the framework refused (out-of-scope file / entity, unknown id) — for logs. */
    warnings: string[];
}

/**
 * The single entity one per-entity LLM call is scoped to, plus the file it may
 * write. The agent loop runs one call per entity, so the apply check is
 * per-entity rather than against the whole roster.
 */
export interface EntityStateReviewScope {
    /** The locale-resolved file this agent owns (`3.人物狀態.md` / `6.勢力與世界.md`). */
    targetFile: string;
    /** The entity this call reviewed — revise must stay inside its section. */
    currentEntityName: string;
    /**
     * Every entity name this agent's provider knows. `newHunks` context must
     * land inside one of these so a prompt slip can't invent a fresh entry —
     * adding brand-new entities is the SaveAgent's job, not this agent's.
     */
    knownEntityNames: ReadonlySet<string>;
}

/**
 * Applies a parsed per-entity review delta to the manifest. Enforces the
 * agent's write scope (the plan's "Apply scope rule"):
 *
 * - `dropHunkIds` → only hunks on `targetFile`. The seed only lists this
 *   entity's hunks, so the LLM can only reference its own ids here.
 * - `reviseHunks` → only `targetFile` hunks whose context sits inside the
 *   current entity's section; no file relocation.
 * - `newHunks` → only `targetFile`, and the context must land inside some
 *   known entity (never a brand-new entry).
 *
 * Perception annotations are stripped before merging — Phase 1 keeps them for
 * the trace (visible in the captured tool-call args) but writes nothing about
 * them into the KB. Anything outside scope is dropped with a warning.
 */
export function applyEntityStateReview(
    hunks: readonly SaveHunk[],
    args: CommitEntityStateReviewArgs,
    scope: EntityStateReviewScope,
    validMessageIds: ReadonlySet<string>,
): EntityStateReviewResult {
    const { targetFile, currentEntityName, knownEntityNames } = scope;
    const warnings: string[] = [];
    const byId = new Map(hunks.map(h => [h.id, h]));

    const dropped = new Set<string>();
    for (const id of args.dropHunkIds) {
        const h = byId.get(id);
        if (!h) { warnings.push(`drop: unknown hunk id "${id}"`); continue; }
        if (h.file !== targetFile) {
            warnings.push(`drop: "${id}" (${h.file}) is outside this agent's file "${targetFile}"`);
            continue;
        }
        dropped.add(id);
    }

    const revised = new Map<string, SaveHunk>();
    for (const r of args.reviseHunks) {
        const h = byId.get(r.id);
        if (!h) { warnings.push(`revise: unknown hunk id "${r.id}"`); continue; }
        if (h.file !== targetFile) {
            warnings.push(`revise: "${r.id}" (${h.file}) is outside this agent's file "${targetFile}"`);
            continue;
        }
        if (r.file !== h.file) {
            warnings.push(`revise: "${r.id}" cannot move from "${h.file}" to "${r.file}"`);
            continue;
        }
        if (!contextInEntity(h.context, currentEntityName)) {
            warnings.push(`revise: "${r.id}" is not inside entity "${currentEntityName}"`);
            continue;
        }
        revised.set(r.id, stripPerception(r));
    }

    const accepted: NewHunk[] = [];
    for (const n of args.newHunks) {
        if (n.file !== targetFile) {
            warnings.push(`new: file "${n.file}" not allowed — must target "${targetFile}"`);
            continue;
        }
        if (!contextInAnyEntity(n.context, knownEntityNames)) {
            warnings.push(`new: context [${n.context.join(' > ')}] does not match a known entity`);
            continue;
        }
        accepted.push(stripPerception(n));
    }

    const kept = hunks
        .filter(h => !dropped.has(h.id))
        // Merge over the original so an LLM that only re-emits the corrected
        // field doesn't drop the hunk's `target` / `sourceMessageIds`.
        .map(h => {
            const r = revised.get(h.id);
            return r ? { ...h, ...r } : h;
        });
    // Offset past the manifest's highest H-number, NOT length — earlier drops
    // leave gaps where length < max, and a length-offset would re-issue a
    // still-live id.
    const stampedNew = withHunkIds(accepted, maxHunkIdNumber(hunks));

    const pruned = pruneInvalidSourceMessageIds([...kept, ...stampedNew], validMessageIds);
    warnings.push(...pruned.warnings);
    return { hunks: pruned.hunks, warnings };
}

/** True when one of the heading crumbs is this entity's name. */
function contextInEntity(context: readonly string[], entityName: string): boolean {
    return context.includes(entityName);
}

/** True when one of the heading crumbs is any known entity's name. */
function contextInAnyEntity(context: readonly string[], known: ReadonlySet<string>): boolean {
    return context.some(c => known.has(c));
}

/** Drops the trace-only perception fields, returning a clean hunk body. */
function stripPerception<T extends EntityNewHunk | EntityReviseHunk>(
    h: T,
): Omit<T, 'perceptionLevel' | 'perceptionReason'> {
    const clean = { ...h };
    delete clean.perceptionLevel;
    delete clean.perceptionReason;
    return clean;
}

/**
 * Defensively parses a raw `commitEntityStateReview` args payload. Field by
 * field; malformed array entries are dropped rather than throwing, so a partly
 * garbled commit still applies its valid parts.
 */
export function parseCommitEntityStateArgs(raw: unknown): CommitEntityStateReviewArgs {
    const obj = isRecord(raw) ? raw : {};
    return {
        dropHunkIds: asStringArray(obj['dropHunkIds']),
        reviseHunks: asArray(obj['reviseHunks']).map(asReviseHunk).filter(isPresent),
        newHunks: asArray(obj['newHunks']).map(asNewHunk).filter(isPresent),
        summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
    };
}

/** Defensively parses a raw `reportNotAnEntity` args payload. */
export function parseReportNotAnEntityArgs(raw: unknown): ReportNotAnEntityArgs {
    const obj = isRecord(raw) ? raw : {};
    return {
        entityName: typeof obj['entityName'] === 'string' ? obj['entityName'] : '',
        reason: typeof obj['reason'] === 'string' ? obj['reason'] : '',
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

function asPerceptionLevel(v: unknown): PerceptionLevel | undefined {
    return v === 'strong' || v === 'medium' || v === 'weak' ? v : undefined;
}

/** Validates the common hunk body; returns the typed fields or null. */
function asHunkBody(v: Record<string, unknown>): NewHunk | null {
    if (typeof v['file'] !== 'string' || typeof v['replacement'] !== 'string') return null;
    const ctx = v['context'];
    if (!Array.isArray(ctx) || !ctx.every(x => typeof x === 'string')) return null;
    const body: NewHunk = { file: v['file'], context: ctx as string[], replacement: v['replacement'] };
    if (typeof v['target'] === 'string') body.target = v['target'];
    if (Array.isArray(v['sourceMessageIds'])) body.sourceMessageIds = asStringArray(v['sourceMessageIds']);
    return body;
}

function withPerception<T extends NewHunk>(body: T, v: Record<string, unknown>): T {
    const level = asPerceptionLevel(v['perceptionLevel']);
    if (level) (body as T & { perceptionLevel?: PerceptionLevel }).perceptionLevel = level;
    if (typeof v['perceptionReason'] === 'string') {
        (body as T & { perceptionReason?: string }).perceptionReason = v['perceptionReason'];
    }
    return body;
}

function asNewHunk(v: unknown): EntityNewHunk | null {
    if (!isRecord(v)) return null;
    const body = asHunkBody(v);
    return body ? withPerception(body, v) : null;
}

function asReviseHunk(v: unknown): EntityReviseHunk | null {
    if (!isRecord(v) || typeof v['id'] !== 'string') return null;
    const body = asHunkBody(v);
    return body ? withPerception({ ...body, id: v['id'] }, v) : null;
}
