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
        pc_state: raw?.pc_state ?? '',
        present_npcs: Array.isArray(raw?.present_npcs)
            ? raw.present_npcs.map(n => ({ name: n?.name ?? '', state: n?.state ?? '' }))
            : [],
        key_objects: Array.isArray(raw?.key_objects)
            ? raw.key_objects.map(o => ({ name: o?.name ?? '', state: o?.state ?? '' }))
            : []
    };
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
            : []
    };
}
