import {
    AnalysisStep,
    SceneSnapshot,
    StructuredAnalysis
} from '@app/core/constants/engine-protocol-structured';
import { StatChange } from '@app/core/models/stats.types';
import { isValidStatKey } from '@app/core/services/stats/stats-yaml.util';

/**
 * Coerces a (possibly partial / malformed) parsed JSON into a fully-shaped
 * {@link StructuredAnalysis}. Both engine modes call this on parser output
 * before handing it to renderers / downstream consumers, so the rendering
 * layer can trust every field exists with the correct type.
 *
 * Legacy compatibility — see {@link normalizeScene} for the `pc_in_header`
 * → `pc_name` shim that covers saves serialized under the pre-split schema.
 */
export function normalizeAnalysis(raw: unknown): StructuredAnalysis {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Partial<StructuredAnalysis>;
    return {
        scene_snapshot: normalizeScene(a.scene_snapshot),
        steps: Array.isArray(a.steps) ? a.steps.map(s => normalizeStep(s)) : []
    };
}

export function normalizeScene(raw: Partial<SceneSnapshot> | undefined): SceneSnapshot {
    // Legacy saves serialized `pc_in_header` as one display string
    // (e.g. "程楊宗[魯蛇](偽裝中)"). Dump it into pc_name; the formatter
    // skips empty alias/state so display equals the pre-split rendering.
    const legacyHeader = (raw as { pc_in_header?: string } | undefined)?.pc_in_header;
    return {
        date_in_world: raw?.date_in_world ?? '',
        time_hhmm: raw?.time_hhmm ?? '',
        location: raw?.location ?? '',
        environment: raw?.environment ?? '',
        pc_name: raw?.pc_name ?? legacyHeader ?? '',
        pc_alias: raw?.pc_alias ?? '',
        pc_state: typeof raw?.pc_state === 'string' && !looksLikeAwareness(raw.pc_state) ? raw.pc_state : '',
        pc_awareness: resolveAwareness(raw?.pc_awareness, raw?.pc_state),
        present_npcs: Array.isArray(raw?.present_npcs)
            ? raw.present_npcs.map(n => ({
                name: typeof n?.name === 'string' ? n.name : '',
                state: typeof n?.state === 'string' && !looksLikeAwareness(n.state) ? n.state : '',
                awareness: resolveAwareness(n?.awareness, n?.state),
                agenda: typeof n?.agenda === 'string' ? n.agenda : ''
            }))
            : [],
        key_objects: Array.isArray(raw?.key_objects)
            ? raw.key_objects.map(o => ({ name: o?.name ?? '', state: o?.state ?? '' }))
            : []
    };
}

/**
 * Legacy migration helper: pre-Phase-1 books wrote consciousness tags
 * (`昏迷` / `熟睡` / `麻痺` / `匿蹤` / `通訊`, plus same-domain inventions)
 * into the `state` field; Phase-1 splits them off into `awareness`.
 *
 * Detection is conservative: a value is treated as legacy-awareness only
 * if it's short and matches one of the canonical keywords (zh + en) or
 * their close paraphrases. Anything else stays in `state` as the new
 * physical/outer-state semantics.
 */
const LEGACY_AWARENESS_KEYWORDS = /^(昏迷|熟睡|麻痺|麻痹|匿蹤|匿跡|通訊|幻象|靈魂出竅|偽裝中|變裝中|化裝中|淺眠.*|unconscious|asleep|paralyzed|hidden|comms|illusion|astral-projecting|disguised|light sleep.*)$/i;

function looksLikeAwareness(s: string | null | undefined): boolean {
    if (typeof s !== 'string') return false;
    const trimmed = s.trim();
    return trimmed.length > 0 && trimmed.length <= 40 && LEGACY_AWARENESS_KEYWORDS.test(trimmed);
}

function resolveAwareness(
    awarenessRaw: unknown,
    legacyState: string | null | undefined
): string {
    if (typeof awarenessRaw === 'string') {
        const trimmed = awarenessRaw.trim();
        if (trimmed.length > 0) return trimmed;
    }
    if (typeof legacyState === 'string' && looksLikeAwareness(legacyState)) {
        return legacyState.trim();
    }
    return '';
}

/**
 * Permissive input shape: parser may hand over a step that still has the
 * pre-rename `kind: "random_event"` (legacy books) or an out-of-enum
 * `source` value. Widen those two fields to plain `string` so the
 * migration logic below can pattern-match without `as` casts.
 */
type LegacyAnalysisStep = Omit<Partial<AnalysisStep>, 'kind' | 'source'> & {
    kind?: AnalysisStep['kind'] | 'random_event';
    source?: string;
};

export function normalizeStep(raw: LegacyAnalysisStep | undefined): AnalysisStep {
    // Legacy: pre-rename books emitted `kind: "random_event"`; current schema
    // uses `kind: "event"` + `source: "random" | "skill_item" | "hook_fire"`.
    // Map old kind to the new pair so existing saves replay unchanged.
    const rawKind = raw?.kind;
    const isEvent = rawKind === 'event' || rawKind === 'random_event';
    const kind: AnalysisStep['kind'] = isEvent ? 'event' : 'user_intent';
    const rawSource = raw?.source;
    const source: AnalysisStep['source'] = isEvent
        ? (rawSource === 'hook_fire' || rawSource === 'skill_item' ? rawSource : 'random')
        : '';
    const hookTitle = source === 'hook_fire' && typeof raw?.hook_title === 'string'
        ? raw.hook_title
        : '';
    const step: AnalysisStep = {
        kind,
        source,
        hook_title: hookTitle,
        action: raw?.action ?? '',
        pc_dialogue: raw?.pc_dialogue ?? '',
        mood: raw?.mood ?? '',
        risk_factors: Array.isArray(raw?.risk_factors) ? raw.risk_factors.filter(r => typeof r === 'string') : [],
        outcome: raw?.outcome ?? '',
        breaks_ideal: raw?.breaks_ideal === true,
        npc_reactions: Array.isArray(raw?.npc_reactions)
            ? raw.npc_reactions.map(r => ({
                actor: r?.actor ?? '',
                physical: r?.physical ?? '',
                dialogue: r?.dialogue ?? '',
                motivation: r?.motivation ?? ''
            }))
            : [],
        object_reactions: Array.isArray(raw?.object_reactions)
            ? raw.object_reactions.map(o => ({ name: o?.name ?? '', change: o?.change ?? '' }))
            : [],
        scene_change: typeof raw?.scene_change === 'string' ? raw.scene_change : ''
    };

    // Opt-out books (and every legacy save) carry no stat_changes — leave the
    // optional field absent so their normalized shape stays byte-identical.
    if (Array.isArray((raw as { stat_changes?: unknown })?.stat_changes)) {
        step.stat_changes = ((raw as { stat_changes: unknown[] }).stat_changes)
            .map(normalizeStatChange)
            .filter((c): c is StatChange => c !== null);
    }

    return step;
}

/**
 * Validates one raw stat-change entry. Returns null (dropped) unless `key` is a
 * non-empty string passing {@link isValidStatKey}. `delta`/`value` survive only
 * when numeric; `subkey`/`reason` only when strings — anything else is omitted.
 * `field` survives only as `"min"`/`"max"` (a bound change); `"value"` / absent
 * / anything else is omitted so a plain value change normalizes byte-identically.
 */
function normalizeStatChange(raw: unknown): StatChange | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const key = r['key'];
    if (typeof key !== 'string' || !isValidStatKey(key)) return null;

    const change: StatChange = { key };
    if (typeof r['subkey'] === 'string') change.subkey = r['subkey'];
    if (r['field'] === 'min' || r['field'] === 'max') change.field = r['field'];
    if (typeof r['delta'] === 'number' && Number.isFinite(r['delta'])) change.delta = r['delta'];
    if (typeof r['value'] === 'number' && Number.isFinite(r['value'])) change.value = r['value'];
    if (typeof r['reason'] === 'string') change.reason = r['reason'];
    return change;
}
