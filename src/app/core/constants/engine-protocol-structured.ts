import { Schema } from '../models/types';

/**
 * Unified structured analysis used by both engine modes (1-call and 2-call).
 *
 * Both modes' first LLM call produces an identical {@link StructuredAnalysis}
 * shape:
 * - 1-call: model emits StructuredAnalysis alongside story / summary / *_log.
 * - 2-call: resolver emits StructuredAnalysis (wrapped with ideal_outcome /
 *   ideal_strength); narrator renders it into prose.
 *
 * Each {@link AnalysisStep} is one atomic step in the turn's sequence — either
 * a `user_intent` step (an action the user described in their input) or an
 * `event` step (a non-user occurrence the model judged this turn — either a
 * third-party / environmental injection (`source: "random"`) or an authored
 * story-hook firing whose trigger condition was met (`source: "hook_fire"`)).
 * All steps carry the same NPC + object reaction fields and the same
 * `breaks_ideal` semantics.
 *
 * When a step is judged `breaks_ideal=true`, the model stops emitting further
 * steps from that turn — the breaking step is the last element of `steps[]`.
 * {@link truncateAtBreak} is a program-side safety net that re-applies the
 * same truncation in case the model fails to short-circuit on its own.
 */

const IDEAL_STRENGTHS = ['perfectionist', 'pragmatic', 'desperate'] as const;
export type IdealStrength = typeof IDEAL_STRENGTHS[number];

export interface PresentNpc {
    name: string;
    /**
     * Physical / outer state — free-form short prose describing what the NPC
     * currently looks like and carries: clothing, equipment, held items,
     * posture, injuries, visible marks. e.g.
     * `"赤裸，依偎於宇成懷中；殘片在床邊衣物堆內"` /
     * `"披風帶兜帽，腰間佩劍，左肩有舊傷"`.
     *
     * `""` = no explicit physical-state info this turn (narrator falls back
     * to KB + history). Distinct from {@link awareness} (reactivity flag)
     * and `npc_reactions[].physical` (momentary motion).
     */
    state: string;
    /**
     * Fog-of-war / consciousness state — gates whether this NPC has the
     * **capacity to react** to the environment / PC actions this turn.
     * Free-form short string CONSTRAINED to that domain — common tags:
     * `"昏迷"` / `"熟睡"` / `"麻痺"` / `"匿蹤"` / `"通訊"` (remote, not
     * physically here); same-domain inventions like `"幻象"` / `"靈魂出竅"`
     * allowed. `""` = default (fully reactive — conscious and on-scene).
     *
     * NOT for emotion, current activity, or behavior — `"旁觀"`, `"交談中"`,
     * `"抱著X"`, `"敵意"` all describe a fully-reactive NPC's choices, which
     * belong in `npc_reactions[].physical` / `motivation`.
     */
    awareness: string;
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
    pc_name: string;
    pc_alias: string;
    /**
     * PC's physical / outer state — semantics aligned with
     * {@link PresentNpc.state}: clothing, equipment, held items, posture,
     * injuries, visible marks. Distinct from {@link pc_awareness}
     * (reactivity flag).
     */
    pc_state: string;
    /**
     * PC's reactivity / consciousness state — semantics aligned with
     * {@link PresentNpc.awareness}. `""` = default (fully reactive).
     */
    pc_awareness: string;
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

const STEP_KINDS = ['user_intent', 'event'] as const;
export type StepKind = typeof STEP_KINDS[number];

export type EventSource = 'random' | 'hook_fire';

export interface AnalysisStep {
    /**
     * Discriminator. `user_intent` for actions the user described in their
     * `<行動意圖>` input; `event` for non-user occurrences the model judged
     * this turn — either a third-party / environmental injection or an
     * authored story-hook firing (further distinguished by {@link source}).
     */
    kind: StepKind;
    /**
     * Sub-discriminator for `kind: "event"` steps:
     * - `"random"`: third-party / environmental injection (NPC arrival,
     *   alarm, weather, etc.). Existing pre-rename semantics.
     * - `"hook_fire"`: an authored hook entry under `{{FILE_STORY_OUTLINE}}`
     *   "啟動劇情引導" had its trigger condition met this turn. Carries
     *   {@link hook_title}; never `breaks_ideal=true`; narrator must give
     *   full sensory awakening prose per `# 劇情引導處理`.
     *
     * Always `""` for `kind: "user_intent"` steps.
     */
    source: EventSource | '';
    /**
     * Exact hook title from `{{FILE_STORY_OUTLINE}}` "啟動劇情引導" when
     * {@link source} is `"hook_fire"`. Always `""` for `kind: "user_intent"`
     * and for `source: "random"` event steps.
     */
    hook_title: string;
    action: string;
    /** Verbatim PC line. Empty for `event` steps. */
    pc_dialogue: string;
    /** PC mood. Empty for `event` steps. */
    mood: string;
    /** Risks. Empty array allowed for `event` steps. */
    risk_factors: string[];
    outcome: string;
    breaks_ideal: boolean;
    npc_reactions: NpcReaction[];
    object_reactions: ObjectReaction[];
    /**
     * Mandatory cumulative state delta from this step. Free-form short prose
     * describing PERSISTING state changes (clothing / equipment / held items /
     * posture / injuries / awareness changes / object physical condition) that
     * survive past the moment of action. Distinct from `npc_reactions[].physical`
     * (momentary motion) and `object_reactions[].change` (single-step event).
     * Use `""` when nothing persistent changes this step.
     */
    scene_change: string;
}

export interface StructuredAnalysis {
    scene_snapshot: SceneSnapshot;
    steps: AnalysisStep[];
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
            description: 'PHYSICAL / OUTER STATE — free-form short prose describing what the NPC currently looks like and carries: clothing / equipment / held items / posture / injuries / visible marks. e.g. "赤裸，依偎於宇成懷中；殘片在床邊衣物堆內" / "披風帶兜帽，腰間佩劍，左肩有舊傷" / "穿便服，雙手束縛於背後". This is the persistent visible state that survives between turns and grows by accumulating each step\'s scene_change. "" = no explicit physical-state info this turn (narrator falls back to KB + history). DISTINCT from `awareness` (reactivity flag) and `npc_reactions[].physical` (momentary motion this step).'
        },
        awareness: {
            type: 'string',
            description: 'FOG-OF-WAR / CONSCIOUSNESS STATE — gates whether this NPC has the CAPACITY TO REACT to the environment / PC actions this turn. Free-form short string CONSTRAINED to that domain. Common tags: "昏迷" / "熟睡" / "麻痺" / "匿蹤" (hidden) / "通訊" (remote, not physically here). Same-domain inventions allowed (e.g. "幻象" / "靈魂出竅" / "淺眠（巨響可醒）"). "" (default) = fully reactive (conscious and on-scene). NOT for emotion, current activity, or behavior — "旁觀" / "交談中" / "抱著X" / "敵意" describe a fully-reactive NPC\'s choices and belong in npc_reactions[].physical / motivation, never here.'
        }
    },
    required: ['name', 'state', 'awareness']
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
        pc_name: {
            type: 'string',
            description: 'PC display name. e.g. "程楊宗" / "艾爾". The program assembles the scene-header presentation from pc_name + pc_alias + pc_state.'
        },
        pc_alias: {
            type: 'string',
            description: 'PC alias / nickname. e.g. "魯蛇" / "銀月". Empty string when no alias. The program wraps this in [] when present.'
        },
        pc_state: {
            type: 'string',
            description: 'PC PHYSICAL / OUTER STATE — same domain as present_npcs[].state: clothing / equipment / held items / posture / injuries / visible marks. e.g. "赤裸，剛沐浴；衣物散於床邊椅子" / "穿夜行衣，背後負劍鞘". Persistent visible state that survives between turns and grows by accumulating each step\'s scene_change. "" = no explicit info this turn (narrator falls back to KB + history). DISTINCT from `pc_awareness` (reactivity flag).'
        },
        pc_awareness: {
            type: 'string',
            description: 'PC FOG-OF-WAR / CONSCIOUSNESS STATE — same domain as present_npcs[].awareness. Common tags: "昏迷" / "偽裝中" / "匿蹤" / "靈魂出竅". "" (default) = fully reactive. NOT for emotion, current activity, or behavior. The program wraps this in () in the scene header when present.'
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
    required: ['date_in_world', 'time_hhmm', 'location', 'environment', 'pc_name', 'pc_alias', 'pc_state', 'pc_awareness', 'present_npcs', 'key_objects']
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
    description: 'One atomic step in the turn\'s sequence — either a user_intent step (an action the user described) or an event step (a non-user occurrence YOU judged this turn — random injection OR an authored story-hook firing; see `source`). Both kinds carry the same NPC + object reaction fields and the same breaks_ideal semantics.',
    properties: {
        kind: {
            type: 'string',
            enum: [...STEP_KINDS],
            description: '"user_intent" for steps the user described in their <行動意圖>; "event" for a non-user occurrence YOU inserted (third-party / environmental injection OR an authored hook firing — see `source`). Insert event steps at the array position where they interrupt the user\'s planned sequence; if an event is judged breaks_ideal=true, subsequent user_intent steps are NOT emitted.'
        },
        source: {
            type: 'string',
            enum: ['', 'random', 'hook_fire'],
            description: 'Sub-discriminator. "random" or "hook_fire" when `kind:"event"`; "" when `kind:"user_intent"`. "random" = third-party / environmental injection (NPC arrival, alarm, weather shift, etc.). "hook_fire" = an authored hook entry under {{FILE_STORY_OUTLINE}} "啟動劇情引導" had its trigger condition met this turn; carries `hook_title`; narrator must give full sensory awakening prose per `# 劇情引導處理`.'
        },
        hook_title: {
            type: 'string',
            description: 'EXACT hook title from {{FILE_STORY_OUTLINE}} "啟動劇情引導" when `source:"hook_fire"`. ALWAYS "" for `kind:"user_intent"` and for `source:"random"` event steps. Reproduce the title verbatim — used downstream to cross-reference the hook entry and to append `(已完成)` at next save.'
        },
        action: {
            type: 'string',
            description: 'For user_intent: verb-phrase rewording of the user input action (e.g. "走向廣場中央" / "嘗試攻擊梨菲"). NOT a verbatim echo — paraphrase objectively. For `source:"random"` event: one-sentence description of the event itself (e.g. "凱爾推門進入並截住艾爾"). For `source:"hook_fire"` event: one-sentence narrative seed describing how the content recorded under that hook surfaces in the current scene.'
        },
        pc_dialogue: {
            type: 'string',
            description: 'For user_intent: verbatim PC line for this step, "" if PC says nothing. MUST match user input verbatim except for typos. For event (any source): always "". The narrator (in 2-call) cannot see the original user input and depends on this field to quote the PC.'
        },
        mood: {
            type: 'string',
            description: 'For user_intent: PC mood mirroring the input\'s [心境] tag, e.g. "平靜" / "緊張" / "困惑", "" if none. For event (any source): always "".'
        },
        risk_factors: {
            type: 'array',
            items: { type: 'string' },
            description: 'For user_intent: risks that could derail this step (e.g. ["梨菲有反擊能力", "大雨影響命中"]). MUST list risks even when outcome is success. For event (any source): usually empty.'
        },
        outcome: {
            type: 'string',
            description: 'Single free-text judgment. For user_intent: "成功 - 勉強站穩" / "部份成功 - 達成A但B被拒" / "伴隨代價的成功 - 翻牆但扭傷腳踝" / "失敗 - 梨菲閃過並反擊". For `source:"random"` event: describe the event\'s immediate effect (e.g. "成功 - 凱爾擋在櫃檯前阻斷接近路徑" / "失敗 - 警鈴觸發，附近護衛全數警覺"). For `source:"hook_fire"` event: judge by the hook\'s content nature — same wording grammar as above, no mandatory "success" override. The narrator quotes this in prose.'
        },
        breaks_ideal: {
            type: 'boolean',
            description: 'TRUE when (and only when) this step prevents the player\'s ideal_outcome from being attained — the action / event did not enter resolution at all. For user_intent triggers: (1) PC ability insufficient (2) NPC autonomous refusal (3) hard environmental block (4) agency conflict (PC has no authority over an NPC\'s decision). For `source:"random"` event: TRUE when the event\'s nature interrupts the user\'s planned sequence (a hostile NPC arrives, an alarm triggers, a friend drags the PC away); FALSE when the event is supportive / neutral and does not block subsequent user_intent steps. For `source:"hook_fire"` event: usually FALSE (hooks are authored augmentations woven into the existing scene), but can be TRUE if the hook content genuinely interrupts the PC\'s action (e.g. a sudden incapacitating revelation). FALSE for "成功 / 部份成功 / 伴隨代價的成功" — the action happened, the result may be imperfect but the intent layer was not violated. When a step is breaks_ideal=true, this MUST be the LAST element of steps[]; do not emit any subsequent step the user attempted. outcome and breaks_ideal must be self-consistent: breaks_ideal=true ⇒ outcome starts with "失敗"; breaks_ideal=false ⇒ outcome starts with "成功 / 部份成功 / 伴隨代價的成功".'
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
        },
        scene_change: {
            type: 'string',
            description: 'Mandatory CUMULATIVE STATE DELTA from this step — short free-form prose describing what physical / outer state PERSISTS past this moment (clothing pulled off, equipment unsheathed, item taken into hand, posture shift that holds, injury sustained, awareness flipped to 昏迷, object physical condition flipped). DISTINCT from npc_reactions[].physical (momentary motion that does not persist) and object_reactions[].change (single-step event description). Leave empty / "" when nothing persistent changes. The narrator (and subsequent turns) reconstruct current scene state by replaying scene_change deltas in order. Examples: "李霜凝衣物已退至腰下；殘片落在床上" / "宇成右手握住劍柄,劍已半出鞘" / "" (nothing persistent).'
        }
    },
    required: ['kind', 'source', 'hook_title', 'action', 'pc_dialogue', 'mood', 'risk_factors', 'outcome', 'breaks_ideal', 'npc_reactions', 'object_reactions', 'scene_change']
};

export const structuredAnalysisSchema: Schema = {
    type: 'object',
    description: 'Structured atomic-action breakdown + judgment. Used by 1-call (alongside story/summary/*_log) and by 2-call resolver (which then hands the analysis to the narrator). For non-action inputs (general <系統> Q&A, <存檔>) callers may pass null instead of this object.',
    properties: {
        scene_snapshot: sceneSnapshotSchema,
        steps: {
            type: 'array',
            description: 'Atomic steps in input order, mixing user_intent and event kinds (where event sub-categorizes into source:"random" / source:"hook_fire"). At least 1 element when this object is non-null. The model stops emitting steps after the first breaks_ideal=true (which becomes the last element); subsequent attempted steps are NOT emitted. Program-side truncation is a safety net only.',
            items: analysisStepSchema
        }
    },
    required: ['scene_snapshot', 'steps']
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
                description: 'One sentence describing what PURPOSE the user was trying to achieve this turn. Infer this from the recent story context (the running plot — accepted quest, ongoing situation, NPC relationship, last few turns) together with the user\'s <行動意圖> input — read the goal behind the action, do not restate the action itself.'
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

/**
 * 1-based index of the first `breaks_ideal=true` step. Returns 0 when not
 * interrupted (or when analysis is absent / steps[] is missing).
 */
export function interruptedAtStep(a: Partial<StructuredAnalysis> | null | undefined): number {
    if (!a || !Array.isArray(a.steps)) return 0;
    const i = a.steps.findIndex(s => s?.breaks_ideal === true);
    return i >= 0 ? i + 1 : 0;
}

export function isInterrupted(a: Partial<StructuredAnalysis> | null | undefined): boolean {
    return interruptedAtStep(a) > 0;
}

/**
 * Hard-stop truncation. Keeps the breaking step itself (narrator needs it to
 * describe HOW the precondition broke) and drops everything after. Returns the
 * input unchanged when no break is found. Does NOT mutate input.
 */
export function truncateAtBreak(a: StructuredAnalysis): StructuredAnalysis {
    const breakStep = interruptedAtStep(a);
    if (breakStep === 0) return a;
    return { ...a, steps: a.steps.slice(0, breakStep) };
}
