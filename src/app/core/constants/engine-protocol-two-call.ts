import { Schema } from '../models/types';
import { getLocale } from './locales';
import { getResolverSchemaV2 } from './engine-protocol-structured';

export type {
    AnalysisStep,
    IdealStrength,
    KeyObject,
    NarratorResponse as NarratorOutput,
    NpcReaction,
    ObjectReaction,
    PresentNpc,
    ResolverResponse as ResolverOutput,
    SceneSnapshot,
    StepKind,
    StructuredAnalysis
} from './engine-protocol-structured';

/**
 * Two-call mode schema definitions. Both calls share the unified
 * {@link StructuredAnalysis} shape (see `engine-protocol-structured.ts`).
 *
 * - **Resolver call** outputs `{ ideal_outcome, ideal_strength, analysis }`.
 *   The program slices `analysis.steps` at the first `breaks_ideal=true` via
 *   `truncateAtBreak`; everything after is dropped before narrator runs.
 * - **Narrator call** receives the truncated analysis + ideal_outcome /
 *   ideal_strength via `buildNarratorUserMessage`, and writes the user-facing
 *   scene. Output mirrors single-call's user-visible subset (story / summary
 *   / *_log) plus an `interrupted_acknowledged` flag.
 */

export const getResolverSchema = (lang = 'default'): Schema => getResolverSchemaV2(lang);

export const getNarratorSchema = (lang = 'default'): Schema => {
    // story / summary / *_log share semantics with single-call's response shape,
    // so the field descriptions reuse single-call's locale strings. Resolver-side
    // fields and the narrator-only `interrupted_acknowledged` are English literals.
    const { responseSchema } = getLocale(lang);

    return {
        type: 'object',
        description: 'Narrator call output. Renders the post-truncation StructuredAnalysis (provided as narrator input) into a user-facing scene. Does NOT see the original user input string — narration must derive purely from analysis.steps and the ideal_outcome / ideal_strength hints.',
        properties: {
            story: {
                type: 'string',
                description: 'User-facing scene prose. Must include the mandatory <CREATIVE FICTION CONTEXT> + bracketed header, then narration of every step in order, quoting NpcReaction.dialogue verbatim wherever non-empty. When the truncated analysis ends in a breaks_ideal=true step, narration stops at that step\'s consequence — no "he was about to say X" prose, no smuggling of dropped steps.'
            },
            summary: { type: 'string', description: responseSchema.summary },
            character_log: { type: 'array', items: { type: 'string' }, description: responseSchema.character },
            inventory_log: { type: 'array', items: { type: 'string' }, description: responseSchema.inventory },
            quest_log: { type: 'array', items: { type: 'string' }, description: responseSchema.quest },
            world_log: { type: 'array', items: { type: 'string' }, description: responseSchema.world },
            interrupted_acknowledged: {
                type: 'boolean',
                description: 'Confirms the narrator received and respected the truncation. True when the input analysis ended in a breaks_ideal=true step.'
            }
        },
        required: ['story', 'summary', 'interrupted_acknowledged']
    };
};
