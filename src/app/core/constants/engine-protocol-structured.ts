import { Schema } from '../models/types';

/**
 * Unified structured analysis used by both engine modes (1-call and 2-call).
 *
 * Both modes' first LLM call produces an identical {@link StructuredAnalysis}
 * shape:
 * - 1-call: model emits StructuredAnalysis alongside story / summary / *_log.
 * - 2-call: resolver emits StructuredAnalysis (wrapped with ideal_outcome /
 *   ideal_strength); program slices `steps[]` at the first `breaks_ideal=true`
 *   step; narrator renders the truncated analysis into prose.
 *
 * Field semantics align with `injection_protocol_single.md`'s 1-call markdown
 * format (【現況】/【動作N】/【全場景N】/【事件】). Each {@link AnalysisStep}
 * is one atomic action in the user-character's input sequence; for every step,
 * the model lists every present NPC and key object's reaction (no short-circuit
 * even when an earlier step broke).
 */

const IDEAL_STRENGTHS = ['perfectionist', 'pragmatic', 'desperate'] as const;
export type IdealStrength = typeof IDEAL_STRENGTHS[number];

export interface PresentNpc {
    name: string;
    /**
     * Fog-of-war / consciousness state — NOT emotion. Drives whether the LLM
     * may have this NPC speak or react. Free-form short string within that
     * domain — examples include `"昏迷"` / `"熟睡"` / `"麻痺"` / `"匿蹤"` /
     * `"通訊"` / `"幻象"` / `"靈魂出竅"` etc., but the model may invent any
     * short tag that captures a similar consciousness / presence constraint.
     * `""` = default (conscious and physically on-scene).
     *
     * Per-turn moods / emotions / personality cues belong in
     * `npc_reactions[].physical` / `motivation`, NOT here.
     */
    state: string;
}

export interface KeyObject {
    name: string;
    state: string;
}

export interface SceneSnapshot {
    date_in_world: string;
    time_hhmm: string;
    location: string;
    environment: string;
    pc_in_header: string;
    present_npcs: PresentNpc[];
    key_objects: KeyObject[];
}

export interface NpcReaction {
    actor: string;
    physical: string;
    dialogue: string;
    motivation: string;
}

export interface ObjectReaction {
    name: string;
    change: string;
}

export interface AnalysisStep {
    action: string;
    pc_dialogue: string;
    mood: string;
    risk_factors: string[];
    outcome: string;
    breaks_ideal: boolean;
    npc_reactions: NpcReaction[];
    object_reactions: ObjectReaction[];
}

export interface RandomEvent {
    triggered: boolean;
    description: string;
}

export interface StructuredAnalysis {
    scene_snapshot: SceneSnapshot;
    steps: AnalysisStep[];
    random_event: RandomEvent;
}

export interface ResolverResponse {
    ideal_outcome: string;
    ideal_strength: IdealStrength;
    analysis: StructuredAnalysis;
}

export interface NarratorResponse {
    story: string;
    summary: string;
    character_log?: string[];
    inventory_log?: string[];
    quest_log?: string[];
    world_log?: string[];
    interrupted_acknowledged: boolean;
}

export interface SingleCallResponse {
    analysis: StructuredAnalysis | null;
    story: string;
    summary: string;
    character_log?: string[];
    inventory_log?: string[];
    quest_log?: string[];
    world_log?: string[];
    correction?: string;
}

const presentNpcSchema: Schema = {
    type: 'object',
    description: 'On-scene NPC entry. Includes hidden, unconscious, and remote-comm NPCs.',
    properties: {
        name: {
            type: 'string',
            description: 'Display name. Aliases use [] (e.g. "莉塔[銀月]"); unknown names use ??? suffix; one-shot mooks use generic role labels.'
        },
        state: {
            type: 'string',
            description: 'Fog-of-war / consciousness state — NOT emotion. Free-form short string CONSTRAINED TO that domain: tells the narrator whether this NPC is awake, present, and able to react. Common tags: "昏迷" / "熟睡" / "麻痺" / "匿蹤" (hidden) / "通訊" (remote-comm, not physically here). The model may invent other short tags fitting the same domain (e.g. "幻象" / "靈魂出竅" / "睡著但會在巨響時醒來"). Use "" (default) for a conscious-and-on-scene NPC. Per-turn moods, emotions, and personality go in npc_reactions[].physical / motivation, NEVER here.'
        }
    },
    required: ['name', 'state']
};

const keyObjectSchema: Schema = {
    type: 'object',
    description: 'Important environmental object — mechanism, trap, special device, or key item. Plain furniture should NOT be listed.',
    properties: {
        name: { type: 'string', description: 'Object label. e.g. "窗戶" / "地上的碎玻璃" / "傳送陣".' },
        state: { type: 'string', description: 'Current state. e.g. "完整" / "半開" / "啟動中" / "破損".' }
    },
    required: ['name', 'state']
};

const sceneSnapshotSchema: Schema = {
    type: 'object',
    description: 'Scene status at the moment this turn ends. Mirrors 1-call markdown\'s 【現況盤點】 block. The program assembles the user-facing scene header (<CREATIVE FICTION CONTEXT> line) from these fields, so emit complete values — do NOT write the header line yourself in story.',
    properties: {
        date_in_world: {
            type: 'string',
            description: 'In-world date with calendar prefix and weekday, e.g. "聖曆 1000年04月02日 週二" / "Space Calendar 1000/04/02 Tue". The calendar name MUST come from the world settings file ({{FILE_BASIC_SETTINGS}}). Estimate progression from the prior turn — across midnight the date MUST advance.'
        },
        time_hhmm: {
            type: 'string',
            description: 'In-world time at the END of this turn, "HH:MM" precision. Estimate from previous turn\'s time + the actions in this turn. NEVER repeat the previous turn\'s exact value across consecutive turns.'
        },
        location: {
            type: 'string',
            description: 'Where the scene is happening, e.g. "新手村 - 冒險者公會櫃檯" / "旅店一樓" / "Inn 1F". Used in the assembled scene header.'
        },
        environment: {
            type: 'string',
            description: 'Free-form prose merging weather / ambience / special conditions in one breath. e.g. "暴雨中，視線不佳，地板濕滑，戰鬥肅殺氣氛". Empty string allowed but at least one keyword is recommended. Distinct from `location` — this is the sensory atmosphere, not the place name.'
        },
        pc_in_header: {
            type: 'string',
            description: 'PC representation as it appears in the scene header, with optional alias and state. e.g. "程楊宗" / "程楊宗[魯蛇]" / "艾爾(平靜)" / "程楊宗[魯蛇](化裝中)". Aliases use [], state uses ().'
        },
        present_npcs: {
            type: 'array',
            description: 'Every NPC currently in scene. Includes hidden, unconscious, and remote-comm NPCs. One-shot mooks (guard A, villager甲) MUST be listed to satisfy the all-NPC reaction rule. Empty array when truly no one is present.',
            items: presentNpcSchema
        },
        key_objects: {
            type: 'array',
            description: 'Every important environmental object. Plain furniture excluded. Empty array if none.',
            items: keyObjectSchema
        }
    },
    required: ['date_in_world', 'time_hhmm', 'location', 'environment', 'pc_in_header', 'present_npcs', 'key_objects']
};

const npcReactionSchema: Schema = {
    type: 'object',
    description: 'How one specific present NPC reacts to this step. Every entry in scene_snapshot.present_npcs MUST appear in this list, including silent observers, unconscious NPCs, and remote-comm NPCs.',
    properties: {
        actor: {
            type: 'string',
            description: 'NPC name. MUST exactly match one entry in scene_snapshot.present_npcs[].name.'
        },
        physical: {
            type: 'string',
            description: 'Physical reaction — gesture, posture, expression, eye movement. ≤ 30 chars recommended. Even silent / unconscious / disinterested NPCs must have a status line (e.g. "仍癱在角落昏迷不醒" / "斜眼瞥視一眼隨後失去興趣").'
        },
        dialogue: {
            type: 'string',
            description: 'Verbatim line this NPC speaks during this step. Empty string if NPC says nothing. When the NPC DOES speak, this MUST be the actual line — DO NOT substitute action paraphrases like "用某某口吻回應" / "嘲笑著說" in place of dialogue.'
        },
        motivation: {
            type: 'string',
            description: 'Motivation tag, e.g. "戰鬥本能+敵意" / "恐懼+逃避" / "職責+不情願". Drives the narrator to surface NPC inner drive in prose. Empty allowed.'
        }
    },
    required: ['actor', 'physical', 'dialogue', 'motivation']
};

const objectReactionSchema: Schema = {
    type: 'object',
    description: 'How one specific key object reacts/changes. Every entry in scene_snapshot.key_objects MUST appear here. Include even no-change rows.',
    properties: {
        name: {
            type: 'string',
            description: 'Object name. MUST match one entry in scene_snapshot.key_objects[].name.'
        },
        change: {
            type: 'string',
            description: 'Change description. RESERVED LITERAL "無變化" when the object is not interacted with and unchanged this step (narrator skips it in prose). On first appearance: describe initial state in detail. On change/interaction: describe the concrete change (e.g. "戰鬥震動使碎片微微滑動").'
        }
    },
    required: ['name', 'change']
};

const analysisStepSchema: Schema = {
    type: 'object',
    description: 'One atomic step in the user character\'s action sequence. The model judges each step independently and lists every present NPC + key object\'s reaction; the program (not the model) truncates downstream steps at the first breaks_ideal=true.',
    properties: {
        action: {
            type: 'string',
            description: 'Verb-phrase action description, e.g. "走向廣場中央" / "嘗試攻擊梨菲". NOT a verbatim echo of the user input — an objective rewording of the action intent. Action target (NPC / object / location) is embedded in this prose.'
        },
        pc_dialogue: {
            type: 'string',
            description: 'Verbatim PC line for this step. "" if the PC says nothing this step. MUST match the user input verbatim except for typo fixes — DO NOT paraphrase or polish. The narrator (in 2-call) cannot see the original user input and depends on this field to quote the PC.'
        },
        mood: {
            type: 'string',
            description: 'PC mood for this step, mirroring the input\'s [心境] tag. e.g. "平靜" / "緊張" / "困惑". "" if none.'
        },
        risk_factors: {
            type: 'array',
            items: { type: 'string' },
            description: 'Risks that could derail this step. e.g. ["梨菲有反擊能力", "大雨影響命中"]. MUST list risks even when outcome is success — drives narrator tension. Empty array allowed only when truly trivial (e.g. PC walks alone in safe room).'
        },
        outcome: {
            type: 'string',
            description: 'Single free-text judgment matching 1-call\'s 【動作N】判定 segment. e.g. "成功 - 勉強站穩" / "部份成功 - 達成A但B被拒" / "伴隨代價的成功 - 翻牆但扭傷腳踝" / "失敗 - 梨菲閃過並反擊". The narrator quotes this in prose.'
        },
        breaks_ideal: {
            type: 'boolean',
            description: 'TRUE iff this step prevents the player\'s ideal_outcome from being attained — the action did not enter resolution at all. Triggers: (1) PC ability insufficient (2) NPC autonomous refusal (3) hard environmental block (4) random event interruption (5) agency conflict (PC has no authority over an NPC\'s decision). FALSE for "成功 / 部份成功 / 伴隨代價的成功" — the action happened, the result may be imperfect but the intent layer was not violated. The program truncates everything AFTER the first breaks_ideal=true; the breaking step itself is kept for narrator. outcome and breaks_ideal must be self-consistent: breaks_ideal=true ⇒ outcome starts with "失敗"; breaks_ideal=false ⇒ outcome starts with "成功 / 部份成功 / 伴隨代價的成功".'
        },
        npc_reactions: {
            type: 'array',
            description: 'EVERY present_npcs entry must appear here, including silent / unconscious / remote-comm NPCs. Missing any present NPC = serious violation. The narrator paraphrases each entry into prose.',
            items: npcReactionSchema
        },
        object_reactions: {
            type: 'array',
            description: 'EVERY key_objects entry must appear here. Use "無變化" for unchanged untouched objects.',
            items: objectReactionSchema
        }
    },
    required: ['action', 'pc_dialogue', 'mood', 'risk_factors', 'outcome', 'breaks_ideal', 'npc_reactions', 'object_reactions']
};

const randomEventSchema: Schema = {
    type: 'object',
    description: 'Random event check for this turn. Mirrors 1-call markdown\'s 【隨機事件】 block.',
    properties: {
        triggered: { type: 'boolean', description: 'Whether a random event fired this turn.' },
        description: { type: 'string', description: 'When triggered=true, one-sentence event description. Empty string when triggered=false.' }
    },
    required: ['triggered', 'description']
};

export const structuredAnalysisSchema: Schema = {
    type: 'object',
    description: 'Structured atomic-action breakdown + judgment. Used by 1-call (alongside story/summary/*_log) and by 2-call resolver (which then hands a truncated copy to the narrator). For non-action inputs (general <系統> Q&A, <存檔>) callers may pass null instead of this object.',
    properties: {
        scene_snapshot: sceneSnapshotSchema,
        steps: {
            type: 'array',
            description: 'Atomic steps in input order. At least 1 element when this object is non-null. Even when an early step has breaks_ideal=true, list all subsequent steps the user attempted — the program (not the model) decides which steps to render.',
            items: analysisStepSchema
        },
        random_event: randomEventSchema
    },
    required: ['scene_snapshot', 'steps', 'random_event']
};

/**
 * Resolver schema for 2-call mode. Wraps {@link structuredAnalysisSchema} with
 * the player-intent fields (ideal_outcome / ideal_strength) the narrator needs
 * but cannot derive (it does not see the original user input).
 *
 * `interrupted` / `interrupted_at_step` are NOT in the schema — the program
 * derives them via {@link isInterrupted} / {@link interruptedAtStep} from
 * `analysis.steps[].breaks_ideal` so the model never self-reports an
 * inconsistent flag.
 */
export const getResolverSchemaV2 = (lang = 'default'): Schema => {
    void lang;
    return {
        type: 'object',
        description: 'Resolver call output. Contains player-intent reading + structured world-reaction analysis. Program derives interruption state from analysis.steps[].breaks_ideal.',
        properties: {
            ideal_outcome: {
                type: 'string',
                description: 'One-sentence paraphrase of what the user is hoping the FULL input sequence achieves (action + dialogue + expected reaction). Narrator references this when writing prose.'
            },
            ideal_strength: {
                type: 'string',
                enum: [...IDEAL_STRENGTHS],
                description: 'How rigid the user\'s expectation is. perfectionist = any deviation is failure; pragmatic = partial success acceptable; desperate = surviving counts as success. Default pragmatic. Drives narrator tension when breaks_ideal=false but outcome is imperfect.'
            },
            analysis: structuredAnalysisSchema
        },
        required: ['ideal_outcome', 'ideal_strength', 'analysis']
    };
};

// ----- program-derived helpers (not in LLM schema) -----

export function isInterrupted(a: StructuredAnalysis | null | undefined): boolean {
    if (!a || !Array.isArray(a.steps)) return false;
    return a.steps.some(s => s?.breaks_ideal === true);
}

/**
 * 1-based index of the first `breaks_ideal=true` step. Returns 0 when not
 * interrupted (or when analysis is absent).
 */
export function interruptedAtStep(a: StructuredAnalysis | null | undefined): number {
    if (!a || !Array.isArray(a.steps)) return 0;
    const i = a.steps.findIndex(s => s?.breaks_ideal === true);
    return i >= 0 ? i + 1 : 0;
}

/**
 * Hard-stop truncation. Keeps the breaking step itself (narrator needs it to
 * describe HOW the precondition broke) and drops everything after. Returns the
 * input unchanged when no break is found. Does NOT mutate input.
 */
export function truncateAtBreak(a: StructuredAnalysis): StructuredAnalysis {
    if (!Array.isArray(a.steps)) return a;
    const idx = a.steps.findIndex(s => s?.breaks_ideal === true);
    if (idx < 0) return a;
    return { ...a, steps: a.steps.slice(0, idx + 1) };
}
