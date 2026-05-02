import { ResolverOutput, ResolverStep } from '../../constants/engine-protocol-v2';

export interface IntentTagSet {
    ACTION: string;
    CONTINUE: string;
    FAST_FORWARD: string;
    SYSTEM: string;
    SAVE: string;
}

const TAG_BY_INTENT: Record<string, keyof IntentTagSet> = {
    action: 'ACTION',
    continue: 'CONTINUE',
    fast_forward: 'FAST_FORWARD',
    system: 'SYSTEM',
    save: 'SAVE'
};

export function applyIntentTag(userInput: string, intent: string, tags: IntentTagSet): string {
    const key = TAG_BY_INTENT[intent];
    if (!key) return userInput;
    const tag = tags[key];
    if (!tag || userInput.trim().startsWith(tag)) return userInput;
    return tag + userInput;
}

/**
 * Assembles the user-message tail for the v2 resolver call.
 *
 * Both `intentInjection` and `protocolResolver` markdowns may contain
 * `{{USER_INPUT}}` placeholders. The (intent-tagged) `userInput` is
 * substituted into both. When either is empty, the wrapper preserves only
 * the non-empty parts so the cache-prefix shape matches the v1 path
 * during partial migrations.
 */
export function buildResolverUserMessage(input: {
    userInput: string;
    intentInjection: string;
    protocolResolver: string;
}): string {
    // Function-form replace so a literal `$&` / `$1` in userInput is not
    // interpreted as a backreference pattern.
    const merged = input.intentInjection.replace(/\{\{USER_INPUT\}\}/g, () => input.userInput);
    const protocol = input.protocolResolver.replace(/\{\{USER_INPUT\}\}/g, () => input.userInput);

    if (merged && protocol) return `${merged}\n\n${protocol}`;
    if (protocol) return protocol;
    if (merged) return merged;
    return input.userInput;
}

/**
 * Assembles the user-message tail for the v2 narrator call.
 *
 * The output is a JSON-fenced narrator-input block followed by the
 * narrator protocol. Original player input is NOT included — narration
 * must derive purely from the structured input.
 *
 * `interrupted` and `break_reason` are derived from the LAST element of
 * `executedSteps`, not from `input.resolver.interrupted`. This keeps the
 * helper safe when callers pass an unsanitized resolver output: a model
 * that self-reports `interrupted=false` but emits a broken step (or the
 * reverse) cannot leak inconsistent state into the narrator. Truncation
 * upstream guarantees that any broken step is the last one in the array.
 */
export function buildNarratorUserMessage(input: {
    resolver: ResolverOutput;
    executedSteps: ResolverStep[];
    protocolNarrator: string;
}): string {
    const sanitizedSteps = input.executedSteps.map(s => ({
        action: s.action,
        action_type: s.action_type,
        target: s.target,
        dialogue: s.dialogue,
        mood: s.mood,
        state_changes: s.state_changes,
        event_type: s.event_type,
        ideal_status: s.ideal_status,
        break_reason: s.ideal_status === 'broken' ? s.break_reason : '',
        npc_reactions: s.npc_reactions,
        ambient: s.ambient
    }));

    const lastStep = sanitizedSteps[sanitizedSteps.length - 1];
    const interrupted = lastStep?.ideal_status === 'broken';
    const breakReason = interrupted ? lastStep.break_reason : '';

    const narratorInput = {
        ideal_outcome: input.resolver.ideal_outcome,
        ideal_strength: input.resolver.ideal_strength,
        interrupted,
        break_reason: breakReason,
        executed_steps: sanitizedSteps
    };

    const inputBlock = '[NARRATOR INPUT]\n```json\n' + JSON.stringify(narratorInput, null, 2) + '\n```';
    return input.protocolNarrator ? `${inputBlock}\n\n${input.protocolNarrator}` : inputBlock;
}
