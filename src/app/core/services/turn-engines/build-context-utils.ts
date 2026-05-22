import { IdealStrength, StructuredAnalysis, isInterrupted } from '@app/core/constants/engine-protocol-structured';

export interface IntentTagSet {
    ACTION: string;
    CONTINUE: string;
    FAST_FORWARD: string;
    SYSTEM: string;
}

const TAG_BY_INTENT: Record<string, keyof IntentTagSet> = {
    action: 'ACTION',
    continue: 'CONTINUE',
    fast_forward: 'FAST_FORWARD',
    system: 'SYSTEM'
};

export function applyIntentTag(userInput: string, intent: string, tags: IntentTagSet): string {
    const key = TAG_BY_INTENT[intent];
    if (!key) return userInput;
    const tag = tags[key];
    if (!tag || userInput.trim().startsWith(tag)) return userInput;
    return tag + userInput;
}

/**
 * Assembles the user-message tail for the two-call resolver call.
 *
 * Both `intentInjection` and `protocolResolver` markdowns may contain
 * `{{USER_INPUT}}` placeholders. The (intent-tagged) `userInput` is
 * substituted into both. When either is empty, the wrapper preserves only
 * the non-empty parts so the cache-prefix shape matches the single-call
 * path during partial migrations.
 */
export function buildResolverUserMessage(input: {
    userInput: string;
    intentInjection: string;
    protocolResolver: string;
    correctionReminder: string;
    idealOutcomeConstraint?: string;
}): string {
    // Function-form replace so literal `$&` / `$1` in any substituted text is
    // not interpreted as a backreference pattern. Correction reminder fills
    // first so the rendered block can itself contain `{{USER_INPUT}}`-like
    // text without it bleeding into the next pass.
    const merged = input.intentInjection
        .replace(/\{\{CORRECTION_REMINDER\}\}/g, () => input.correctionReminder)
        .replace(/\{\{USER_INPUT\}\}/g, () => input.userInput);
    const protocol = input.protocolResolver
        .replace(/\{\{IDEAL_OUTCOME_CONSTRAINT\}\}/g, () => input.idealOutcomeConstraint ?? '')
        .replace(/\{\{USER_INPUT\}\}/g, () => input.userInput);

    if (merged && protocol) return `${merged}\n\n${protocol}`;
    if (protocol) return protocol;
    if (merged) return merged;
    return input.userInput;
}

/**
 * Assembles the user-message tail for the two-call narrator call.
 *
 * The output is a JSON-fenced narrator-input block followed by the
 * narrator protocol. Original player input is NOT included — narration
 * must derive purely from the structured input.
 *
 * `interrupted` is derived from `truncatedAnalysis.steps[].breaks_ideal`
 * via {@link isInterrupted}, so a model that self-reports an inconsistent
 * flag cannot leak through. Truncation upstream guarantees that any breaking
 * step is the LAST step in the array.
 */
export function buildNarratorUserMessage(input: {
    idealOutcome: string;
    idealStrength: IdealStrength;
    truncatedAnalysis: StructuredAnalysis;
    protocolNarrator: string;
    correction: string;
}): string {
    const narratorInput: Record<string, unknown> = {
        ideal_outcome: input.idealOutcome,
        ideal_strength: input.idealStrength,
        interrupted: isInterrupted(input.truncatedAnalysis),
        analysis: input.truncatedAnalysis
    };
    if (input.correction) {
        narratorInput['correction'] = input.correction;
    }

    // Use tilde fences instead of backticks — JSON.stringify does not escape
    // backticks, so dialogue containing ``` would prematurely close a backtick
    // fence and confuse the model.
    const inputBlock = '[NARRATOR INPUT]\n~~~json\n' + JSON.stringify(narratorInput, null, 2) + '\n~~~';
    return input.protocolNarrator ? `${inputBlock}\n\n${input.protocolNarrator}` : inputBlock;
}
