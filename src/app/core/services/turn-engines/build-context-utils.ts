import { IdealStrength, StructuredAnalysis, isInterrupted } from '@app/core/constants/engine-protocol-structured';
import { StatValues } from '@app/core/models/stats.types';

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

/**
 * Resolve the sentinel-delimited stats section in a resolver/narrator protocol.
 *
 * The prompt source wraps every stats instruction (static mechanics text + the
 * `{{...}}` slots) in an HTML-comment sentinel pair so the WHOLE section can
 * vanish when stats are off — string slot-replacement alone can't strip the
 * static prose sitting between the slots. `<name>` is the sentinel id
 * (`STATS_SECTION` / `NARRATOR_STATS_GUIDANCE`).
 *
 * - `enabled=false` → the region (sentinels included, plus the one trailing
 *   blank line that follows the closing sentinel in the source) is removed —
 *   byte-identical to a book that never had stats. The source wraps the section
 *   with a blank line before AND after, so eating only the sentinel's own
 *   newline would leave `\n\n\n` where a no-stats book has `\n\n`.
 * - `enabled=true` → only the sentinel comment lines are stripped; the body
 *   (with its slots already substituted by the caller) and the surrounding
 *   blank lines stay intact.
 */
export function resolveStatsSection(protocol: string, name: string, enabled: boolean): string {
    if (!enabled) {
        const disabledRegion = new RegExp(`<!--${name}-->\\r?\\n[\\s\\S]*?<!--/${name}-->\\r?\\n(\\r?\\n)?`);
        return protocol.replace(disabledRegion, '');
    }
    const region = new RegExp(`<!--${name}-->\\r?\\n([\\s\\S]*?)<!--/${name}-->\\r?\\n?`);
    return protocol.replace(region, (_full, body: string) => body);
}

/**
 * Neutralize `{{...}}` slot syntax in author/runtime-derived text so a later
 * slot-substitution pass (e.g. `{{USER_INPUT}}`) can't fire inside it. A
 * zero-width space inserted between the braces breaks the `\{\{` / `\}\}`
 * match while staying invisible to the model.
 */
const ZWSP = String.fromCharCode(0x200b);
export function escapeSlots(text: string): string {
    return text.replace(/\{\{/g, '{' + ZWSP + '{').replace(/\}\}/g, '}' + ZWSP + '}');
}

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
    // Post-turn folded stat values + triggered-event strings from the two-call
    // seam. Emitted as sibling JSON fields only when present and non-empty —
    // omitted entirely for non-stats books so the narrator input is unchanged.
    pcStats?: StatValues;
    triggeredEvents?: string[];
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
    if (input.pcStats && Object.keys(input.pcStats).length > 0) {
        narratorInput['pc_stats'] = input.pcStats;
    }
    if (input.triggeredEvents && input.triggeredEvents.length > 0) {
        narratorInput['triggered_events'] = input.triggeredEvents;
    }

    // Use tilde fences instead of backticks — JSON.stringify does not escape
    // backticks, so dialogue containing ``` would prematurely close a backtick
    // fence and confuse the model.
    const inputBlock = '[NARRATOR INPUT]\n~~~json\n' + JSON.stringify(narratorInput, null, 2) + '\n~~~';
    return input.protocolNarrator ? `${inputBlock}\n\n${input.protocolNarrator}` : inputBlock;
}
