import { describe, expect, it } from 'vitest';
import {
    applyIntentTag,
    buildResolverUserMessage,
    buildNarratorUserMessage,
    type IntentTagSet
} from './build-context-utils';
import type { ResolverOutput, ResolverStep } from '../../constants/engine-protocol-two-call';

const TAGS: IntentTagSet = {
    ACTION: '<行動意圖>',
    CONTINUE: '<繼續>',
    FAST_FORWARD: '<快轉>',
    SYSTEM: '<系統>',
    SAVE: '<存檔>'
};

function step(overrides: Partial<ResolverStep> = {}): ResolverStep {
    return {
        action: 'walk',
        action_type: 'movement',
        target: '',
        dialogue: '',
        mood: 'calm',
        state_changes: [],
        event_type: 'ambient',
        ideal_status: 'intact',
        break_reason: '',
        npc_reactions: [],
        ambient: '',
        ...overrides
    };
}

function resolver(overrides: Partial<ResolverOutput> = {}): ResolverOutput {
    return {
        ideal_outcome: 'introduce self via handshake',
        ideal_strength: 'pragmatic',
        steps: [],
        interrupted: false,
        interrupted_at_step: 0,
        ...overrides
    };
}

describe('applyIntentTag', () => {
    it('prepends the action tag for action intent', () => {
        expect(applyIntentTag('hello', 'action', TAGS)).toBe('<行動意圖>hello');
    });

    it('does not double-prepend when input already starts with the tag', () => {
        expect(applyIntentTag('<繼續>more', 'continue', TAGS)).toBe('<繼續>more');
    });

    it('returns the input unchanged for an unknown intent', () => {
        expect(applyIntentTag('hello', 'unknown', TAGS)).toBe('hello');
    });

    it('treats whitespace before the tag as already-tagged (skip prepend)', () => {
        expect(applyIntentTag('  <存檔>tail', 'save', TAGS)).toBe('  <存檔>tail');
    });

    it('uses the snake_case fast_forward intent value (matches GAME_INTENTS)', () => {
        expect(applyIntentTag('skip', 'fast_forward', TAGS)).toBe('<快轉>skip');
    });
});

describe('buildResolverUserMessage', () => {
    it('replaces {{USER_INPUT}} in both intent and resolver protocols', () => {
        const out = buildResolverUserMessage({
            userInput: 'walk forward',
            intentInjection: 'INTENT: {{USER_INPUT}}',
            protocolResolver: 'PROTOCOL: {{USER_INPUT}}',
            correctionReminder: ''
        });
        expect(out).toBe('INTENT: walk forward\n\nPROTOCOL: walk forward');
    });

    it('falls back to protocol-only when intent injection is empty', () => {
        const out = buildResolverUserMessage({
            userInput: 'x',
            intentInjection: '',
            protocolResolver: 'PROTO {{USER_INPUT}}',
            correctionReminder: ''
        });
        expect(out).toBe('PROTO x');
    });

    it('falls back to intent-only when resolver protocol is empty (mid-migration)', () => {
        const out = buildResolverUserMessage({
            userInput: 'y',
            intentInjection: 'I {{USER_INPUT}}',
            protocolResolver: '',
            correctionReminder: ''
        });
        expect(out).toBe('I y');
    });

    it('returns just the user input when both injections are empty', () => {
        expect(buildResolverUserMessage({
            userInput: 'z',
            intentInjection: '',
            protocolResolver: '',
            correctionReminder: ''
        })).toBe('z');
    });

    it('replaces every occurrence of the placeholder, not just the first', () => {
        const out = buildResolverUserMessage({
            userInput: 'a',
            intentInjection: '{{USER_INPUT}}/{{USER_INPUT}}',
            protocolResolver: '',
            correctionReminder: ''
        });
        expect(out).toBe('a/a');
    });

    it('substitutes {{CORRECTION_REMINDER}} with the rendered block', () => {
        const out = buildResolverUserMessage({
            userInput: 'walk',
            intentInjection: '{{CORRECTION_REMINDER}}\n\nIntent: {{USER_INPUT}}',
            protocolResolver: '',
            correctionReminder: 'CORRECTION: cat is white'
        });
        expect(out).toBe('CORRECTION: cat is white\n\nIntent: walk');
    });

    it('drops {{CORRECTION_REMINDER}} to empty when no reminder is supplied', () => {
        const out = buildResolverUserMessage({
            userInput: 'walk',
            intentInjection: '{{CORRECTION_REMINDER}}\n\nIntent: {{USER_INPUT}}',
            protocolResolver: '',
            correctionReminder: ''
        });
        expect(out).toBe('\n\nIntent: walk');
    });

    it('does not interpret $&/$1 backreferences in the correction reminder text', () => {
        const out = buildResolverUserMessage({
            userInput: 'x',
            intentInjection: '{{CORRECTION_REMINDER}}',
            protocolResolver: '',
            correctionReminder: '$1 and $& survived'
        });
        expect(out).toBe('$1 and $& survived');
    });

    it('substitutes {{IDEAL_OUTCOME_CONSTRAINT}} into the resolver protocol when supplied', () => {
        const out = buildResolverUserMessage({
            userInput: 'walk',
            intentInjection: '',
            protocolResolver: 'PROTO\n\n{{IDEAL_OUTCOME_CONSTRAINT}}\n\n{{USER_INPUT}}',
            correctionReminder: '',
            idealOutcomeConstraint: 'CONSTRAINT: hit eyebrow'
        });
        expect(out).toBe('PROTO\n\nCONSTRAINT: hit eyebrow\n\nwalk');
    });

    it('drops {{IDEAL_OUTCOME_CONSTRAINT}} to empty when no constraint is supplied', () => {
        const out = buildResolverUserMessage({
            userInput: 'walk',
            intentInjection: '',
            protocolResolver: 'PROTO\n\n{{IDEAL_OUTCOME_CONSTRAINT}}\n\n{{USER_INPUT}}',
            correctionReminder: ''
        });
        expect(out).toBe('PROTO\n\n\n\nwalk');
    });

    it('does not interpret $&/$1 backreferences in the ideal-outcome constraint text', () => {
        const out = buildResolverUserMessage({
            userInput: 'x',
            intentInjection: '',
            protocolResolver: '{{IDEAL_OUTCOME_CONSTRAINT}}',
            correctionReminder: '',
            idealOutcomeConstraint: '$1 and $& survived'
        });
        expect(out).toBe('$1 and $& survived');
    });
});

describe('buildNarratorUserMessage', () => {
    it('does not include the original user input string', () => {
        const out = buildNarratorUserMessage({
            resolver: resolver({ ideal_outcome: 'X', interrupted: false }),
            executedSteps: [step({ action: 'walk', dialogue: 'hi' })],
            protocolNarrator: 'NARR',
            correction: ''
        });
        // The narrator must not see the raw user input; only structured data is present.
        expect(out).toContain('[NARRATOR INPUT]');
        expect(out).toContain('"action": "walk"');
        expect(out).toContain('NARR');
    });

    it('zeros break_reason on intact steps even if the input had one', () => {
        const out = buildNarratorUserMessage({
            resolver: resolver({ interrupted: false }),
            executedSteps: [step({ ideal_status: 'intact', break_reason: 'leaked text' })],
            protocolNarrator: '',
            correction: ''
        });
        expect(out).not.toContain('leaked text');
        expect(out).toContain('"break_reason": ""');
    });

    it('derives interrupted + break_reason from the last step (broken), ignoring the resolver flag', () => {
        const out = buildNarratorUserMessage({
            // Resolver self-reports false; helper must override based on the actual broken step.
            resolver: resolver({ interrupted: false }),
            executedSteps: [
                step({ action: 'a' }),
                step({ action: 'b', ideal_status: 'broken', break_reason: 'NPC refused' })
            ],
            protocolNarrator: '',
            correction: ''
        });
        const parsed = JSON.parse(out.split('~~~json\n')[1].split('\n~~~')[0]);
        expect(parsed.interrupted).toBe(true);
        expect(parsed.break_reason).toBe('NPC refused');
    });

    it('forces interrupted=false when resolver claims true but no step is broken', () => {
        const out = buildNarratorUserMessage({
            resolver: resolver({ interrupted: true }),
            executedSteps: [step({ action: 'a' })],
            protocolNarrator: '',
            correction: ''
        });
        const parsed = JSON.parse(out.split('~~~json\n')[1].split('\n~~~')[0]);
        expect(parsed.interrupted).toBe(false);
        expect(parsed.break_reason).toBe('');
    });

    it('omits the trailing protocol section when protocolNarrator is empty', () => {
        const out = buildNarratorUserMessage({
            resolver: resolver(),
            executedSteps: [step()],
            protocolNarrator: '',
            correction: ''
        });
        expect(out.endsWith('~~~')).toBe(true);
    });

    it('round-trips ideal_outcome / ideal_strength / interrupted into the JSON block', () => {
        const out = buildNarratorUserMessage({
            resolver: resolver({ ideal_outcome: 'X', ideal_strength: 'desperate', interrupted: false }),
            executedSteps: [step()],
            protocolNarrator: '',
            correction: ''
        });
        const parsed = JSON.parse(out.split('~~~json\n')[1].split('\n~~~')[0]);
        expect(parsed.ideal_outcome).toBe('X');
        expect(parsed.ideal_strength).toBe('desperate');
        expect(parsed.interrupted).toBe(false);
    });

    it('embeds the correction string into the narrator JSON when supplied', () => {
        const out = buildNarratorUserMessage({
            resolver: resolver(),
            executedSteps: [step()],
            protocolNarrator: '',
            correction: '原劇情誤寫紅色禮服；後續以藍色制服為準。'
        });
        const parsed = JSON.parse(out.split('~~~json\n')[1].split('\n~~~')[0]);
        expect(parsed.correction).toBe('原劇情誤寫紅色禮服；後續以藍色制服為準。');
    });

    it('omits the correction field entirely when empty (no leakage as undefined/null)', () => {
        const out = buildNarratorUserMessage({
            resolver: resolver(),
            executedSteps: [step()],
            protocolNarrator: '',
            correction: ''
        });
        const parsed = JSON.parse(out.split('~~~json\n')[1].split('\n~~~')[0]);
        expect('correction' in parsed).toBe(false);
    });
});
