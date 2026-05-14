import {
    AnalysisStep,
    SceneSnapshot,
    StructuredAnalysis
} from '@app/core/constants/engine-protocol-structured';

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
    // (e.g. "程楊宗[魯蛇](化裝中)"). Dump it into pc_name; the formatter
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
                name: n?.name ?? '',
                state: typeof n?.state === 'string' && !looksLikeAwareness(n.state) ? n.state : '',
                awareness: resolveAwareness((n as { awareness?: unknown } | undefined)?.awareness, n?.state)
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
const LEGACY_AWARENESS_KEYWORDS = /^(昏迷|熟睡|麻痺|麻痹|匿蹤|匿跡|通訊|幻象|靈魂出竅|化裝中|淺眠.*|unconscious|asleep|paralyzed|hidden|comms|illusion|astral-projecting|disguised|light sleep.*)$/i;

function looksLikeAwareness(s: string | null | undefined): boolean {
    if (typeof s !== 'string') return false;
    const trimmed = s.trim();
    return trimmed.length > 0 && trimmed.length <= 40 && LEGACY_AWARENESS_KEYWORDS.test(trimmed);
}

function resolveAwareness(
    awarenessRaw: unknown,
    legacyState: string | null | undefined
): string {
    if (typeof awarenessRaw === 'string' && awarenessRaw.trim().length > 0) {
        return awarenessRaw;
    }
    if (typeof legacyState === 'string' && looksLikeAwareness(legacyState)) {
        return legacyState;
    }
    return '';
}

export function normalizeStep(raw: Partial<AnalysisStep> | undefined): AnalysisStep {
    return {
        kind: raw?.kind === 'random_event' ? 'random_event' : 'user_intent',
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
}
