import { Schema } from '../models/types';

/**
 * v2 (two-call) schema definitions.
 *
 * These are pure data — no caller yet. The orchestrator (PR3) will pass them
 * to the LLM provider for the resolver and narrator calls respectively.
 *
 * Design summary (see TextRPG_Plans/two-call-engine-separation.md):
 *
 * - **Resolver call** does atomic-action breakdown, judges each step, and
 *   tags the first one whose precondition broke. Output is structured
 *   `steps[]` plus an `interrupted` flag the program uses to truncate.
 * - **Narrator call** receives the post-truncation steps + idealOutcome and
 *   writes the user-facing scene. Output mirrors v1's user-visible subset
 *   (story / summary / *_log) but takes an `interrupted` hint so it can
 *   handle the hard-stop case correctly.
 *
 * The localized field descriptions reuse v1's `locale.responseSchema` strings
 * where they map cleanly (summary / *_log) since the per-field semantics did
 * not change. Resolver-specific fields use English descriptions inline — the
 * resolver's prompt injection carries the full localized rules; the schema
 * description here is just a one-line type doc for the LLM.
 */

const ACTION_TYPES = ['movement', 'speech', 'physical', 'mental', 'magic', 'item_use', 'social', 'observation', 'wait'] as const;
const EVENT_TYPES = ['ambient', 'precondition_break', 'urgent', 'random', 'npc_initiative', 'environmental'] as const;
const IDEAL_STATUS = ['intact', 'broken'] as const;
const IDEAL_STRENGTHS = ['perfectionist', 'pragmatic', 'desperate'] as const;
const NPC_REACTION_TYPES = ['comply', 'resist', 'ignore', 'attack', 'flee', 'observe', 'negotiate', 'mock'] as const;

const stepSchema: Schema = {
    type: 'object',
    description: 'One atomic step in the user character\'s attempted action sequence, judged independently.',
    properties: {
        action: { type: 'string', description: 'Verb-phrase description of what the user character attempts in this step.' },
        action_type: { type: 'string', enum: [...ACTION_TYPES], description: 'Coarse category of the attempt.' },
        target: { type: 'string', description: 'Target NPC, object, or location of the action. Empty string if none.' },
        dialogue: { type: 'string', description: 'Verbatim line the user character speaks in this step. Empty string if no speech.' },
        mood: { type: 'string', description: 'Mood/intent qualifier for the action (e.g., "calm", "tense", "playful"). Mirrors the user input\'s [心境] tag.' },
        state_changes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Telegraphic state deltas this step would cause if it succeeds (e.g., "PC.location=plaza-center", "NPC.farmer.alertness+1"). Free-form strings; the narrator paraphrases them.'
        },
        event_type: { type: 'string', enum: [...EVENT_TYPES], description: 'Classification of the world reaction this step triggers.' },
        ideal_status: { type: 'string', enum: [...IDEAL_STATUS], description: '"broken" iff the precondition for the user\'s ideal_outcome failed at this step. The program truncates everything after the first broken step.' },
        break_reason: { type: 'string', description: 'When ideal_status is "broken", a one-sentence reason. Empty otherwise.' },
        npc_reactions: {
            type: 'array',
            description: 'One entry per relevant on-scene NPC. Reactions must be verb phrases ≤ 20 chars; longer prose belongs in the narrator output.',
            items: {
                type: 'object',
                properties: {
                    actor: { type: 'string', description: 'NPC name or generic role.' },
                    reaction: { type: 'string', description: 'Short verb phrase, ≤ 20 chars (e.g., "steps back warily").' },
                    type: { type: 'string', enum: [...NPC_REACTION_TYPES], description: 'Reaction category.' }
                },
                required: ['actor', 'reaction', 'type']
            }
        },
        ambient: { type: 'string', description: 'One-sentence environmental note (weather change, object state, ambient sound) tied to this step. Empty if no change.' }
    },
    required: ['action', 'action_type', 'event_type', 'ideal_status', 'npc_reactions']
};

export const getResolverSchema = (lang = 'default'): Schema => {
    // The resolver schema fields don't currently vary by locale (the prompt
    // injection carries localized rules); accept lang for future extension.
    void lang;
    return {
        type: 'object',
        description: 'Resolver call output. The LLM atomically breaks down the user character\'s action, judges each step, and flags the first precondition break. The program truncates everything after the first broken step before passing executed_steps to the narrator.',
        properties: {
            ideal_outcome: {
                type: 'string',
                description: 'One-sentence paraphrase of what the user is hoping the full sequence achieves. The narrator references this when writing the truncated scene.'
            },
            ideal_strength: {
                type: 'string',
                enum: [...IDEAL_STRENGTHS],
                description: 'How rigid the user\'s expectation is. "perfectionist" = any deviation breaks; "pragmatic" = partial success acceptable; "desperate" = even bad outcomes count as success if survived.'
            },
            steps: {
                type: 'array',
                description: 'Atomic steps in user-input order. Each step is judged independently; LLM does NOT short-circuit at the first broken step — list every step the user attempted, with ideal_status set per step.',
                items: stepSchema
            },
            interrupted: {
                type: 'boolean',
                description: 'True iff at least one step has ideal_status="broken". Redundant with the steps array but the narrator reads this flag directly.'
            },
            interrupted_at_step: {
                type: 'integer',
                description: '1-based index of the first broken step, or 0 when interrupted=false. The program uses this for hard-stop truncation.'
            }
        },
        required: ['ideal_outcome', 'ideal_strength', 'steps', 'interrupted']
    };
};

export const getNarratorSchema = (lang = 'default'): Schema => {
    // Field-level localized descriptions reuse v1's locale strings where the
    // semantics are identical (summary / *_log). Story description stays
    // English here; the narrator injection carries the full localized rules.
    // We accept lang for future extension but currently only summary / *_log
    // descriptions vary by locale.
    void lang;

    return {
        type: 'object',
        description: 'Narrator call output. Renders the post-truncation step list + ideal_outcome into a user-facing scene. Does NOT see the original user input string — narration must derive purely from executed_steps and the interrupted hint to prevent smuggling unexecuted dialogue or actions.',
        properties: {
            story: {
                type: 'string',
                description: 'User-facing scene prose. Must include the mandatory <CREATIVE FICTION CONTEXT> + bracketed header, then narration of every executed step in order. When interrupted=true, narration stops at the broken step\'s consequence — no "he was about to say X" prose, no smuggling of truncated dialogue.'
            },
            summary: { type: 'string', description: 'High-density telegraphic context log for future turns. Same [EVT] / [NPC] / [PLOT] structure as v1.' },
            character_log: { type: 'array', items: { type: 'string' }, description: 'Per-turn changes to protagonist + named NPCs. Same labels as v1 (狀態變化 / 位置更新 / 持有變化 / 裝備變更 etc).' },
            inventory_log: { type: 'array', items: { type: 'string' }, description: 'Protagonist-owned item changes this turn. Same labels as v1 (獲得 / 消耗 / 移入 / 寄存 / 取回 / 穿戴 / 卸下 / 校正).' },
            quest_log: { type: 'array', items: { type: 'string' }, description: 'Quest / long-term plan changes this turn.' },
            world_log: { type: 'array', items: { type: 'string' }, description: 'World events, faction moves, technology / magic developments this turn.' },
            interrupted_acknowledged: {
                type: 'boolean',
                description: 'Confirms the narrator received and respected the interrupted flag. Echoes input.interrupted; mismatch is a model error.'
            }
        },
        required: ['story', 'summary', 'interrupted_acknowledged']
    };
};
