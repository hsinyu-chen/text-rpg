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
 * Normalize a name for roster matching — strips whitespace, folds full-width
 * parens to half-width, lowercases. The model frequently returns a name with
 * minor formatting drift (`露娜（Luna）` vs `露娜 (Luna)`, stray spaces, casing);
 * a verbatim compare would drop it, which — given triage's recall-over-precision
 * goal — is exactly the silent miss we must avoid.
 */
function normalizeEntityName(s: string): string {
    return s.replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').toLowerCase();
}

/**
 * Matches a parsed triage selection against the real entity roster, normalizing
 * both sides so formatting drift doesn't drop a real pick. The selection's name
 * is mapped back to the exact roster spelling (the per-entity loop filters by
 * verbatim roster name). A name with no roster match is dropped with a warning
 * rather than silently; duplicates keep the first selection.
 */
export function resolveTriageSubset(
    entityNames: ReadonlySet<string>, selection: TriageSelectionArgs,
): TriageSubsetResult {
    const selected: TriageEntitySelection[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const canonicalByNormalized = new Map<string, string>();
    for (const name of entityNames) canonicalByNormalized.set(normalizeEntityName(name), name);

    for (const e of selection.entities) {
        const canonical = canonicalByNormalized.get(normalizeEntityName(e.name));
        if (!canonical) {
            warnings.push(`triage: unknown entity "${e.name}" (not in roster) — dropped`);
            continue;
        }
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        selected.push({ ...e, name: canonical });
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
