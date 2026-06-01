import type { LLMFunctionDeclaration } from '@hcs/llm-core';

/**
 * The single terminal tool of the per-entity triage step plus its subset
 * resolver. The triage agent reads the whole target file at once and decides
 * **which entities need per-entity processing this save** — it writes no state
 * update; that's the per-entity agents' job. Its only exit is
 * `commitTriageSelection`, structurally denying it any way to make an edit.
 */

/** Triage's terminal action name — "here is who needs processing". */
export const COMMIT_TRIAGE_SELECTION = 'commitTriageSelection';

/** Per-entity job letters: 'A' = fact verify / correct, 'B' = time-elapse projection. */
export type TriageJob = 'A' | 'B';

/** One selected entity — name + which jobs it needs + a one-line reason. */
export interface TriageEntitySelection {
    /** Entity name, copied verbatim from the seed roster (matched against the provider list). */
    name: string;
    /** Which jobs this entity needs (recall over precision — include if unsure). */
    jobs: TriageJob[];
    /** One short sentence on why this entity needs work — threaded into its per-entity seed. */
    reason: string;
}

/** Parsed, type-checked `commitTriageSelection` payload. */
export interface TriageSelectionArgs {
    /** The subset that needs per-entity processing. Empty = nobody this save. */
    entities: TriageEntitySelection[];
}

/** The run-constant seed context the triage agent shares with the per-entity loop. */
export interface TriageSeedContext {
    /** Bullet list of the available KB filenames. */
    fileList: string;
    /** This ACT's scene-header time window. */
    timeSpan: { start: string; end: string };
    /** This ACT's character_log + world_log digest, by message id. */
    logDigest: string;
}

/** Triage terminal tool declaration handed to the LLM. */
export const COMMIT_TRIAGE_SELECTION_TOOL: LLMFunctionDeclaration = {
    name: COMMIT_TRIAGE_SELECTION,
    description:
        'Finalize triage. Report ONLY the entities that need per-entity processing this save — who, which jobs, and why. '
        + 'Call this EXACTLY ONCE as your final action. You do NOT write any state update here; deciding WHO is your whole job. '
        + 'If you are unsure whether an entity needs work, INCLUDE it (recall over precision — the per-entity step will no-op if it turns out fine).',
    parameters: {
        type: 'object',
        properties: {
            entities: {
                type: 'array',
                description: 'The subset needing processing. Omit entities that clearly need neither a Job A correction nor a Job B projection. An empty array means nobody needs processing this save.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Entity name, copied verbatim from the roster in the seed.' },
                        jobs: {
                            type: 'array',
                            items: { type: 'string', enum: ['A', 'B'] },
                            description: "Which jobs this entity needs: 'A' = verify/correct the SaveAgent's existing hunks, 'B' = time-elapse projection of off-screen evolution. Include both when both apply.",
                        },
                        reason: { type: 'string', description: 'One short sentence: why this entity needs processing (which event, or why projection applies).' },
                    },
                    required: ['name', 'jobs', 'reason'],
                },
            },
        },
        required: ['entities'],
    },
};

/** Result of matching a triage selection against the real roster. */
export interface TriageSubsetResult {
    /** Selections whose name matched a known entity (deduped, first wins). */
    selected: TriageEntitySelection[];
    /** Names the agent picked that don't exist in the roster — dropped, for the trace. */
    warnings: string[];
}

/**
 * Matches a parsed triage selection against the real entity roster. A name the
 * agent invented (not in the roster) can't be processed, so it's dropped with a
 * warning rather than silently. Duplicate names keep the first selection.
 */
export function resolveTriageSubset(
    entityNames: ReadonlySet<string>, selection: TriageSelectionArgs,
): TriageSubsetResult {
    const selected: TriageEntitySelection[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const e of selection.entities) {
        if (!entityNames.has(e.name)) {
            warnings.push(`triage: unknown entity "${e.name}" (not in roster) — dropped`);
            continue;
        }
        if (seen.has(e.name)) continue;
        seen.add(e.name);
        selected.push(e);
    }
    return { selected, warnings };
}

/** Defensively parses a raw `commitTriageSelection` args payload. Malformed
 *  entries are dropped rather than throwing, so a partly garbled selection still
 *  yields its valid picks. */
export function parseTriageSelectionArgs(raw: unknown): TriageSelectionArgs {
    const obj = isRecord(raw) ? raw : {};
    const entities = asArray(obj['entities']).map(asSelection).filter(isPresent);
    return { entities };
}

function asSelection(v: unknown): TriageEntitySelection | null {
    if (!isRecord(v) || typeof v['name'] !== 'string') return null;
    const reason = typeof v['reason'] === 'string' ? v['reason'] : '';
    return { name: v['name'], jobs: asJobs(v['jobs']), reason };
}

function asJobs(v: unknown): TriageJob[] {
    return asArray(v).filter((x): x is TriageJob => x === 'A' || x === 'B');
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
