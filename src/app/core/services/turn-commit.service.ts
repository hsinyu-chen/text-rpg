import { Injectable, inject } from '@angular/core';

import { CostService } from './cost.service';
import { GameStateService } from './game-state.service';
import { ChatHistoryService } from './chat-history.service';
import { SessionService } from './session.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { StreamProcessResult } from './stream-processor.service';

import { ChatMessage, ExtendedPart } from '../models/types';
import { STORY_INTENTS } from '../constants/game-intents';

/**
 * Per-turn context produced by the engine's setup phase, consumed by the
 * commit phase. Lives here because the commit service is the only collaborator
 * that needs to read it; the engine also fills it.
 */
export interface TurnContext {
    userText: string;
    options?: RunTurnOptions;
    currentIntent: string;
    forceFullContext: boolean;
    switchedFromLegacy: boolean;
    userMsgId: string;
    modelMsgId: string;
}

export interface RunTurnOptions {
    isHidden?: boolean;
    intent?: string;
    /**
     * Optional user-supplied ideal_outcome for two-call resolver. When non-empty,
     * ContextBuilder injects it into the resolver's protocol via the
     * {{IDEAL_OUTCOME_CONSTRAINT}} slot on the next turn. Carried on the user
     * message so it persists across reloads / rewinds.
     */
    userIdealOutcome?: string;
    /**
     * Set when this call is the auto-resend triggered by a `<系統>` correction.
     * Its presence drives post-turn cleanup: the system pair + the original
     * (now-failed) action user message become ref-only, and the correction
     * string is transplanted onto the freshly-committed corrective story
     * model message so Layer 1 (stateUpdates summary) keeps propagating it.
     */
    isCorrectionResend?: {
        systemUserId: string;
        systemModelId: string;
        oldStoryUserId: string;
        correctionText: string;
    };
}

export interface CorrectionState {
    isCorrection: boolean;
    correction: string;
    correctedIntent?: string;
    /** Set so commitModelMessage can flip the prior story model to ref-only in
     *  the same pass — keeps the turn at one chat-history write. */
    oldStoryModelId?: string;
    oldStoryUserId?: string;
    oldStoryUserContent?: string;
    oldStoryUserIdealOutcome?: string;
}

/**
 * Owns phases 6-8 of the turn pipeline: correction handling, model-message
 * commit (parts assembly + ref-only cleanup), usage / cost / book persist,
 * and assembling the auto-resend payload. The orchestrator (GameEngineService)
 * is responsible for actually scheduling the resend microtask — this service
 * just builds the payload, keeping it free of recursion into the engine.
 */
@Injectable({ providedIn: 'root' })
export class TurnCommitService {
    private cost = inject(CostService);
    private state = inject(GameStateService);
    private chatHistory = inject(ChatHistoryService);
    private session = inject(SessionService);
    private providerRegistry = inject(LLMProviderRegistryService);

    /**
     * Phase 6: if the engine returned a `<系統>` correction, locate the last
     * non-ref-only story-intent model message and capture the paired user
     * message. **Pure lookup** — no state mutation; the actual ref-only flip
     * is folded into commitModelMessage so the turn lands as one IDB write.
     */
    applyCorrection(result: StreamProcessResult): CorrectionState {
        if (!result.correction) return { isCorrection: false, correction: '' };
        console.log('[TurnCommit] Correction detected:', result.correction);

        const captured: CorrectionState = { isCorrection: true, correction: result.correction };
        const messages = this.state.messages();
        for (let i = messages.length - 2; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === 'model' && !msg.isRefOnly && msg.intent && (STORY_INTENTS as string[]).includes(msg.intent)) {
                captured.oldStoryModelId = msg.id;
                captured.correctedIntent = msg.intent;
                // Guard the index so a malformed history starting with a
                // model message doesn't trip an out-of-bounds read.
                if (i > 0) {
                    const paired = messages[i - 1];
                    if (paired.role === 'user') {
                        captured.oldStoryUserId = paired.id;
                        captured.oldStoryUserContent = paired.content;
                        captured.oldStoryUserIdealOutcome = paired.userIdealOutcome;
                    }
                }
                console.log('[TurnCommit] Identified old story model for ref-only marking:', msg.id);
                break;
            }
        }
        return captured;
    }

    /**
     * Phase 7: single update covers three concerns in one IDB write —
     *  (a) committing the just-finished model message (always)
     *  (b) flipping the prior story model to ref-only when this turn carried
     *      a correction (was a separate write before bot review round 1)
     *  (c) post-resend cleanup when this turn was triggered as a correction
     *      resend: ref-only the system pair + original action user msg, and
     *      transplant the correction string onto the freshly-committed
     *      corrective story model so Layer 1 stateUpdates keeps propagating
     *      the rule going forward.
     */
    commitModelMessage(turn: TurnContext, result: StreamProcessResult, correction: CorrectionState): void {
        const resendOpts = !correction.isCorrection ? turn.options?.isCorrectionResend : undefined;
        this.chatHistory.updateMessages(prev => prev.map((m, i) => {
            const isLast = i === prev.length - 1;
            if (isLast && m.role === 'model') {
                return this.buildCommittedModelMessage(m, turn, result, correction, resendOpts);
            }
            if (correction.isCorrection && m.id === correction.oldStoryModelId) {
                return { ...m, isRefOnly: true };
            }
            if (resendOpts && (m.id === resendOpts.systemUserId || m.id === resendOpts.systemModelId || m.id === resendOpts.oldStoryUserId)) {
                return { ...m, isRefOnly: true };
            }
            return m;
        }));
    }

    /** Pure parts assembly: function-calls → thoughts → story (with optional thoughtSignature). */
    private buildCommittedModelMessage(
        base: ChatMessage,
        turn: TurnContext,
        result: StreamProcessResult,
        correction: CorrectionState,
        resendOpts: RunTurnOptions['isCorrectionResend']
    ): ChatMessage {
        const { capturedFCs, finalThought, finalAnalysis, finalStory, capturedThoughtSignature } = result;
        const parts: ExtendedPart[] = [];
        if (capturedFCs.length > 0) parts.push(...capturedFCs);
        if (finalThought) parts.push({ thought: true, text: finalThought });
        if (finalAnalysis) parts.push({ thought: true, text: finalAnalysis });
        if (finalStory) {
            const storyPart: ExtendedPart = { text: finalStory };
            if (capturedThoughtSignature && capturedFCs.length === 0) {
                storyPart.thoughtSignature = capturedThoughtSignature;
            }
            parts.push(storyPart);
        } else if (capturedThoughtSignature && capturedFCs.length === 0 && parts.length > 0) {
            parts[parts.length - 1].thoughtSignature = capturedThoughtSignature;
        }

        return {
            ...base,
            isThinking: false,
            parts,
            content: result.finalStory,
            analysis: result.finalAnalysis,
            thought: result.finalThought,
            summary: result.finalSummary,
            character_log: result.finalCharacterLog,
            inventory_log: result.finalInventoryLog,
            quest_log: result.finalQuestLog,
            world_log: result.finalWorldLog,
            usage: result.turnUsage,
            contextTokens: result.contextTokens,
            // intent stays the user's original (SYSTEM for correction-declaration
            // turns, story intent for normal turns). The auto-resend produces a
            // separate story-intent turn — we no longer fuse the correction
            // declaration into the corrected story slot inline.
            intent: turn.currentIntent,
            // For correction-resend, transplant the prior system model's correction
            // string here so Layer 1 keeps the rule alive after the system pair
            // becomes ref-only above.
            correction: resendOpts ? resendOpts.correctionText : (correction.isCorrection ? correction.correction : base.correction)
        };
    }

    /** Phase 8: usage stats + token totals + cost + book save + status='idle'. */
    async recordUsageAndPersist(result: StreamProcessResult): Promise<void> {
        // Robust calculation: prompt may be total or fresh-only depending on provider/timings.
        const turnUsage = result.turnUsage;
        const cachedTokens = turnUsage.cached || 0;
        const rawPrompt = turnUsage.prompt || 0;
        const fresh = rawPrompt >= cachedTokens ? rawPrompt - cachedTokens : rawPrompt;

        this.state.lastTurnUsage.set({
            freshInput: fresh,
            cached: cachedTokens,
            output: turnUsage.candidates || 0
        });

        const turnCost = this.cost.calculateTurnCost({
            prompt: turnUsage.prompt || 0,
            candidates: turnUsage.candidates || 0,
            cached: turnUsage.cached || 0
        }, this.providerRegistry.getActiveModelId());
        this.state.lastTurnCost.set(turnCost);

        this.state.tokenUsage.update(prev => ({
            freshInput: prev.freshInput + fresh,
            cached: prev.cached + (turnUsage.cached || 0),
            output: prev.output + (turnUsage.candidates || 0),
            total: prev.total + (turnUsage.prompt || 0) + (turnUsage.candidates || 0)
        }));

        console.log(`[TurnCommit] Turn Usage Breakdown:
- FRESH Input (Not in Cache): ${fresh.toLocaleString()} tokens
  (Includes Chat History + Tool Outputs + System Instructions not in KB)
- CACHED Input (Knowledge Base): ${(turnUsage.cached || 0).toLocaleString()} tokens
- Output: ${turnUsage.candidates.toLocaleString()} tokens
- Turn Cost: $${turnCost.toFixed(5)}`);

        await this.session.saveCurrentSessionToBook();
        this.state.status.set('idle');
    }

    /**
     * Tail builder: returns the resend payload if a correction was just
     * accepted; orchestrator schedules the microtask. Returning instead of
     * scheduling keeps this service free of recursion into the engine path.
     */
    buildAutoResendPayload(
        turn: TurnContext,
        result: StreamProcessResult,
        correction: CorrectionState
    ): { userText: string; options: RunTurnOptions } | null {
        if (!correction.isCorrection || !correction.correctedIntent || !correction.oldStoryUserId || correction.oldStoryUserContent === undefined) {
            return null;
        }
        return {
            userText: correction.oldStoryUserContent,
            options: {
                intent: correction.correctedIntent,
                // Carry the original action's user-supplied ideal_outcome through
                // the resend so the corrective resolver run keeps the same
                // constraint (otherwise it silently reverts to full inference,
                // which can re-introduce the very mismatch the correction fixed).
                userIdealOutcome: correction.oldStoryUserIdealOutcome,
                isCorrectionResend: {
                    systemUserId: turn.userMsgId,
                    systemModelId: turn.modelMsgId,
                    oldStoryUserId: correction.oldStoryUserId,
                    correctionText: result.correction
                }
            }
        };
    }
}
