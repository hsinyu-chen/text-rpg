import { Injectable, inject } from '@angular/core';
import { LLMContent, LLMProvider, LLMProviderCapabilities, LLMProviderConfig } from '@hcs/llm-core';
import { MatSnackBar } from '@angular/material/snack-bar';

import { CostService } from './cost.service';
import { GameStateService } from './game-state.service';
import { ChatHistoryService } from './chat-history.service';
import { CacheManagerService } from './cache-manager.service';
import { SessionService } from './session.service';
import { ContextBuilderService, BuildContext } from './context-builder.service';
import { AppConfigStore } from './app-config-store';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { stripSystemMainMarker } from './profile-compat';
import { SingleCallTurnEngine } from './turn-engines/single-call-turn-engine.service';
import { TwoCallTurnEngine } from './turn-engines/two-call-turn-engine.service';
import type { TurnEngine } from './turn-engines/turn-engine.interface';
import { InjectionService } from './injection.service';
import { StreamProcessResult } from './stream-processor.service';

import { ChatMessage, ExtendedPart } from '../models/types';
import { GAME_INTENTS, STORY_INTENTS } from '../constants/game-intents';
import { getIntentTags, getUIStrings } from '../constants/engine-protocol';
import { DEFAULT_PROFILE_ID } from '../constants/prompt-profiles';

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

/** Per-turn state that survives across phase helpers. */
interface TurnContext {
    userText: string;
    options?: RunTurnOptions;
    currentIntent: string;
    forceFullContext: boolean;
    switchedFromLegacy: boolean;
    userMsgId: string;
    modelMsgId: string;
}

interface ComposedRequest {
    buildCtx: BuildContext;
    history: LLMContent[];
    engine: TurnEngine;
    lang: string;
    provider: LLMProvider;
    providerConfig: LLMProviderConfig;
    cachedContentName: string | undefined;
    systemInstruction: string;
    abortSignal: AbortSignal;
}

interface CorrectionState {
    isCorrection: boolean;
    correction: string;
    correctedIntent?: string;
    oldStoryUserId?: string;
    oldStoryUserContent?: string;
    oldStoryUserIdealOutcome?: string;
}

/**
 * Owns the per-turn pipeline: cache validation, engine dispatch, model-message
 * commit, usage bookkeeping, and `<系統>` auto-resend. Extracted from
 * GameEngineService so the hot path is readable on its own.
 *
 * `runTurn` is an 8-phase orchestrator; each phase is a private helper
 * threaded through `TurnContext` (per-turn state), `ComposedRequest` (frozen
 * snapshot of context + provider + history), and `StreamProcessResult` (the
 * engine's reply).
 */
@Injectable({ providedIn: 'root' })
export class TurnPipelineService {
    private cost = inject(CostService);
    private snackBar = inject(MatSnackBar);
    private state = inject(GameStateService);
    private chatHistory = inject(ChatHistoryService);
    private cacheManager = inject(CacheManagerService);
    private session = inject(SessionService);
    private contextBuilder = inject(ContextBuilderService);
    private singleCallEngine = inject(SingleCallTurnEngine);
    private twoCallEngine = inject(TwoCallTurnEngine);
    private injection = inject(InjectionService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private appConfig = inject(AppConfigStore);

    private currentAbortController: AbortController | null = null;

    /** Constructs the JSON payload that will be sent to the LLM API for preview. */
    getPreviewPayload(userText: string, options?: { intent?: string }) {
        return this.contextBuilder.getPreviewPayload(this.snapshotBuildContext(), userText, options);
    }

    /**
     * Sends a message to the LLM and updates the chat history in real-time.
     * Phases:
     *   0 validateRunTurnArgs → 1 startTurn → 2 prepareCacheOrAbort →
     *   3 composeRequest → 4 executeTurn → 5 surfaceFinishReason →
     *   6 applyCorrection → 7 commitModelMessage → 8 recordUsageAndPersist →
     *   tail: scheduleAutoResendIfNeeded
     */
    async runTurn(userText: string, options?: RunTurnOptions): Promise<void> {
        console.log('[TurnPipeline] runTurn received with intent:', options?.intent);
        if (!this.validateRunTurnArgs(userText, options)) return;

        const turn = await this.startTurn(userText, options);
        if (!(await this.prepareCacheOrAbort(turn))) return;

        try {
            const req = this.composeRequest(turn);
            const result = await this.executeTurn(req, turn);
            this.surfaceFinishReason(result);
            const correction = this.applyCorrection(result);
            this.commitModelMessage(turn, result, correction);
            await this.recordUsageAndPersist(result);
            this.scheduleAutoResendIfNeeded(turn, result, correction);
        } catch (e: unknown) {
            this.handleTurnError(e);
        }
    }

    /** Aborts the current generation process. */
    stopGeneration() {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }
        this.state.status.set('idle');
    }

    // ===== Phase helpers =====================================================

    /** Phase 0: reject empty text on intents that demand input (ACTION/SYSTEM/FAST_FORWARD or default). */
    private validateRunTurnArgs(userText: string, options?: RunTurnOptions): boolean {
        const isActionOrSystem = !options?.intent
            || options.intent === GAME_INTENTS.ACTION
            || options.intent === GAME_INTENTS.SYSTEM
            || options.intent === GAME_INTENTS.FAST_FORWARD;
        return !(isActionOrSystem && !userText.trim());
    }

    /** Phase 1: legacy-fork autoswitch + push the user message + flip status to generating. */
    private async startTurn(userText: string, options?: RunTurnOptions): Promise<TurnContext> {
        const switchedFromLegacy = await this.autoSwitchIfLegacyProfile();
        const userMsgId = crypto.randomUUID();
        const modelMsgId = crypto.randomUUID();
        const userIdealOutcome = options?.userIdealOutcome?.trim() || undefined;

        this.updateMessages(prev => [...prev, {
            id: userMsgId,
            role: 'user',
            content: userText,
            parts: [{ text: userText }],
            isRefOnly: false,
            isHidden: options?.isHidden,
            intent: options?.intent,
            userIdealOutcome
        }]);

        this.state.status.set('generating');

        return {
            userText,
            options,
            currentIntent: options?.intent || GAME_INTENTS.ACTION,
            // <存檔> intent forces full context regardless of UI setting.
            forceFullContext: options?.intent === GAME_INTENTS.SAVE,
            switchedFromLegacy,
            userMsgId,
            modelMsgId
        };
    }

    /**
     * Phase 2: ensureCacheValid; on failure surfaces a snackbar (with the legacy-
     * autoswitch note prepended when applicable) and returns false. Returns true
     * to continue.
     */
    private async prepareCacheOrAbort(turn: TurnContext): Promise<boolean> {
        try {
            await this.ensureCacheValid();
            return true;
        } catch (e: unknown) {
            const sessionExpired = e instanceof Error && e.message === 'SESSION_EXPIRED';
            if (sessionExpired) {
                // Service threw without committing a result. resetCacheState
                // clears all four kbCache signals AND stops the storage timer —
                // otherwise we'd keep accumulating cost against a cache that's
                // gone server-side.
                this.cacheManager.resetCacheState();
            }
            const ui = getUIStrings(this.appConfig.outputLanguage());
            const autoswitchPrefix = turn.switchedFromLegacy ? `${ui.LEGACY_PROFILE_AUTOSWITCH}\n\n` : '';
            const message = sessionExpired
                ? autoswitchPrefix + 'Session Expired: Please reload your Knowledge Base folder to continue.'
                : autoswitchPrefix + `Error: ${e instanceof Error ? e.message : 'Unknown error during cache refresh'}`;
            this.snackBar.open(message, 'Close', {
                duration: sessionExpired ? 10000 : 5000,
                panelClass: ['snackbar-error']
            });
            this.state.status.set('idle');
            return false;
        }
    }

    /**
     * Phase 3: snapshot every state signal once; build base history; choose
     * single-vs-two-call engine and augment history accordingly; resolve
     * provider / cached-content / system-instruction; arm the abort controller.
     * Also surfaces the (post-cache-success) legacy-autoswitch warning here so
     * a cache error snackbar from phase 2 doesn't replace it.
     */
    private composeRequest(turn: TurnContext): ComposedRequest {
        // Snapshot once. Every signal read for the rest of this turn — both
        // the context builder calls below and the engine's downstream
        // resolver/narrator calls — operates on this frozen view, so a
        // mid-turn config edit / profile switch / message append cannot
        // cause two halves of the same turn to disagree.
        const buildCtx = this.snapshotBuildContext();
        const baseHistory = this.contextBuilder.getLLMHistory(buildCtx, turn.forceFullContext);
        const lang = buildCtx.outputLanguage || 'default';

        if (turn.switchedFromLegacy) {
            const ui = getUIStrings(lang);
            this.snackBar.open(ui.LEGACY_PROFILE_AUTOSWITCH, ui.CLOSE, {
                duration: 8000,
                panelClass: ['snackbar-warning']
            });
        }

        // Two-call only applies to story intents — SYSTEM/SAVE bypass the
        // resolver/narrator split (they have no atomic-action semantics).
        const useTwoCall = buildCtx.engineMode === 'two-call' && (STORY_INTENTS as string[]).includes(turn.currentIntent);
        let history: LLMContent[];
        let engine: TurnEngine;
        if (useTwoCall) {
            history = baseHistory;
            engine = this.twoCallEngine;
            console.log(`[TurnPipeline] Dispatching two-call engine for intent ${turn.currentIntent}`);
        } else {
            history = this.augmentSingleCallHistory(buildCtx, baseHistory, turn.currentIntent, lang);
            engine = this.singleCallEngine;
        }

        this.currentAbortController = new AbortController();
        const provider = buildCtx.provider;
        if (!provider) throw new Error('No active LLM provider');
        // The engine never inspects provider capabilities or cache state for
        // the include/omit-KB decision; that's done here.
        const omitKB = this.contextBuilder.shouldOmitKbFromSystemInstruction(buildCtx);

        return {
            buildCtx,
            history,
            engine,
            lang,
            provider,
            providerConfig: this.providerRegistry.getActiveConfig(),
            cachedContentName: buildCtx.kbCacheName || undefined,
            systemInstruction: this.contextBuilder.getEffectiveSystemInstruction(buildCtx, !omitKB),
            abortSignal: this.currentAbortController.signal
        };
    }

    /** Phase 4: dispatch to the chosen engine. */
    private executeTurn(req: ComposedRequest, turn: TurnContext): Promise<StreamProcessResult> {
        return req.engine.runTurn({
            history: req.history,
            intent: turn.currentIntent,
            outputLanguage: req.lang,
            modelMsgId: turn.modelMsgId,
            signal: req.abortSignal,
            updateMessages: (updater) => this.updateMessages(updater),
            provider: req.provider,
            providerConfig: req.providerConfig,
            cachedContentName: req.cachedContentName,
            systemInstruction: req.systemInstruction,
            buildContext: req.buildCtx
        });
    }

    /** Phase 5: a non-stop / non-null finish reason → warning snackbar. */
    private surfaceFinishReason(result: StreamProcessResult): void {
        const reason = result.finalFinishReason;
        if (!reason) return;
        const normalized = reason.toLowerCase();
        if (normalized === 'stop' || normalized === 'null') return;
        const ui = getUIStrings(this.appConfig.outputLanguage());
        this.snackBar.open(`${ui.STOP_REASON_PREFIX || 'Model Stopped:'} ${reason}`, ui.CLOSE, {
            duration: 8000,
            panelClass: ['snackbar-warning']
        });
    }

    /**
     * Phase 6: if the engine returned a `<系統>` correction, walk back to the
     * last non-ref-only story-intent model message, mark it ref-only, and
     * capture the paired user message so the auto-resend (phase tail) can
     * replay the original action.
     */
    private applyCorrection(result: StreamProcessResult): CorrectionState {
        if (!result.correction) return { isCorrection: false, correction: '' };
        const storyIntents: string[] = [GAME_INTENTS.ACTION, GAME_INTENTS.CONTINUE, GAME_INTENTS.FAST_FORWARD];
        console.log('[TurnPipeline] Correction detected:', result.correction);

        const captured: CorrectionState = { isCorrection: true, correction: result.correction };
        this.updateMessages(prev => {
            const updated = [...prev];
            for (let i = updated.length - 2; i >= 0; i--) {
                const msg = updated[i];
                if (msg.role === 'model' && !msg.isRefOnly && msg.intent && storyIntents.includes(msg.intent)) {
                    updated[i] = { ...msg, isRefOnly: true };
                    captured.correctedIntent = msg.intent;
                    // Guard the index so a malformed history starting with a
                    // model message doesn't trip an out-of-bounds read.
                    if (i > 0) {
                        const paired = updated[i - 1];
                        if (paired.role === 'user') {
                            captured.oldStoryUserId = paired.id;
                            captured.oldStoryUserContent = paired.content;
                            captured.oldStoryUserIdealOutcome = paired.userIdealOutcome;
                        }
                    }
                    console.log('[TurnPipeline] Marked old story model ref-only:', msg.id);
                    break;
                }
            }
            return updated;
        });
        return captured;
    }

    /**
     * Phase 7: a single update covers two concerns —
     *  (a) committing the just-finished model message (always)
     *  (b) post-resend cleanup when this turn was triggered as a correction
     *      resend: ref-only the system pair + original action user msg, and
     *      transplant the correction string onto the freshly-committed
     *      corrective story model so Layer 1 stateUpdates keeps propagating
     *      the rule going forward.
     */
    private commitModelMessage(turn: TurnContext, result: StreamProcessResult, correction: CorrectionState): void {
        const resendOpts = !correction.isCorrection ? turn.options?.isCorrectionResend : undefined;
        this.updateMessages(prev => prev.map((m, i) => {
            const isLast = i === prev.length - 1;
            if (isLast && m.role === 'model') {
                return this.buildCommittedModelMessage(m, turn, result, correction, resendOpts);
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

    /** Phase 8: usage stats + token totals + cost + book save + status='idle' + clear abort controller. */
    private async recordUsageAndPersist(result: StreamProcessResult): Promise<void> {
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

        const turnCost = this.calculateTurnCost({
            prompt: turnUsage.prompt || 0,
            candidates: turnUsage.candidates || 0,
            cached: turnUsage.cached || 0
        });
        this.state.lastTurnCost.set(turnCost);

        this.state.tokenUsage.update(prev => ({
            freshInput: prev.freshInput + fresh,
            cached: prev.cached + (turnUsage.cached || 0),
            output: prev.output + (turnUsage.candidates || 0),
            total: prev.total + (turnUsage.prompt || 0) + (turnUsage.candidates || 0)
        }));

        console.log(`[TurnPipeline] Turn Usage Breakdown:
- FRESH Input (Not in Cache): ${fresh.toLocaleString()} tokens
  (Includes Chat History + Tool Outputs + System Instructions not in KB)
- CACHED Input (Knowledge Base): ${(turnUsage.cached || 0).toLocaleString()} tokens
- Output: ${turnUsage.candidates.toLocaleString()} tokens
- Turn Cost: $${turnCost.toFixed(5)}`);

        await this.session.saveCurrentSessionToBook();
        this.state.status.set('idle');
        this.currentAbortController = null;
    }

    /**
     * Tail: schedule the post-correction auto-resend on the microtask queue.
     * Microtask placement guarantees the new runTurn doesn't see itself as
     * re-entrant — the current turn's status flip to 'idle' has already
     * committed by the time the microtask runs. The resend goes through the
     * normal engine, so two-call mode produces the corrected story via
     * resolver+narrator (the whole point of the auto-resend pattern). Cleanup
     * of the system pair + correction transplant happens inside that next
     * turn's `isCorrectionResend` post-commit hook.
     */
    private scheduleAutoResendIfNeeded(turn: TurnContext, result: StreamProcessResult, correction: CorrectionState): void {
        if (!correction.isCorrection || !correction.correctedIntent || !correction.oldStoryUserId || correction.oldStoryUserContent === undefined) return;
        const resendOpts: RunTurnOptions = {
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
        };
        const oldStoryUserContent = correction.oldStoryUserContent;
        queueMicrotask(() => {
            this.runTurn(oldStoryUserContent, resendOpts).catch(err => {
                // runTurn has its own try/catch and surfaces user-facing errors
                // via snackbar + status='error'. Anything that escapes that net
                // (push of the empty user msg failing, etc.) lands here.
                // Logging keeps it visible instead of becoming a silent
                // unhandled rejection. The system pair stays non-ref-only on
                // failure so the user can manually retry or delete it.
                console.error('[TurnPipeline] Auto-resend after correction failed:', err);
            });
        });
    }

    /** Catches errors thrown anywhere in phases 3-tail. AbortError is the silent path. */
    private handleTurnError(e: unknown): void {
        this.currentAbortController = null;
        if (e instanceof Error && e.name === 'AbortError') {
            console.log('[TurnPipeline] Generation aborted.');
            // Reset status — without this, an abort that didn't come from
            // stopGeneration() (e.g. external signal cancellation when a
            // bridge HTTP read times out mid-stream) leaves state.status
            // stuck on 'generating' and every subsequent runTurn is rejected
            // as 'busy' until a full page reload.
            this.state.status.set('idle');
            return;
        }
        console.error(e);
        this.state.status.set('error');

        const ui = getUIStrings(this.appConfig.outputLanguage());
        const errMsg = (e instanceof Error) ? e.message : ui.CONN_ERROR;
        this.updateMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'model') {
                last.isThinking = false;
                last.content = ui.ERR_PREFIX.replace('{error}', errMsg);
                last.parts = [{ text: last.content }];
            } else {
                updated.push({ id: crypto.randomUUID(), role: 'model', content: ui.ERR_PREFIX.replace('{error}', errMsg), isRefOnly: true });
            }
            this.snackBar.open(ui.GEN_FAILED.replace('{error}', errMsg), ui.CLOSE, {
                duration: 5000,
                panelClass: ['snackbar-error']
            });
            return updated;
        });
    }

    // ===== Support helpers ===================================================

    private updateMessages(updater: (prev: ChatMessage[]) => ChatMessage[]) {
        this.chatHistory.updateMessages(updater);
    }

    private calculateTurnCost(turnUsage: { prompt: number, candidates: number, cached?: number }) {
        return this.cost.calculateTurnCost(turnUsage, this.providerRegistry.getActiveModelId());
    }

    /**
     * Captures every signal the context builder reads, in one shot. The
     * returned object is what each ContextBuilder method now operates on
     * — caller never re-enters state mid-call. Used by both `runTurn`
     * (engine path) and `getPreviewPayload` (chat-input live preview).
     */
    private snapshotBuildContext(): BuildContext {
        const provider = this.providerRegistry.getActive();
        // Defensive default for `cacheBakesContent` matches the historical
        // `?? true` fallback in ContextBuilder. The engine path itself
        // throws on a null provider before constructing TurnRunInput, so
        // this default only fires on the preview path's edge case.
        const providerCapabilities = provider?.getCapabilities()
            ?? ({ cacheBakesContent: true } as LLMProviderCapabilities);
        return {
            messages: this.state.messages(),
            contextMode: this.state.contextMode(),
            saveContextMode: this.state.saveContextMode(),
            smartContextTurns: this.appConfig.smartContextTurns(),
            systemInstructionCache: this.state.systemInstructionCache(),
            loadedFiles: this.state.loadedFiles(),
            kbCacheName: this.state.kbCacheName(),
            providerCapabilities,
            dynamicAction: this.state.dynamicActionInjection(),
            dynamicContinue: this.state.dynamicContinueInjection(),
            dynamicFastforward: this.state.dynamicFastforwardInjection(),
            dynamicSystem: this.state.dynamicSystemInjection(),
            dynamicSave: this.state.dynamicSaveInjection(),
            dynamicProtocolResolver: this.state.dynamicProtocolResolverInjection(),
            dynamicProtocolNarrator: this.state.dynamicProtocolNarratorInjection(),
            dynamicProtocolSingle: this.state.dynamicProtocolSingleInjection(),
            dynamicCorrection: this.state.dynamicCorrectionInjection(),
            engineMode: this.appConfig.engineMode(),
            modelId: this.providerRegistry.getActiveModelId() || undefined,
            outputLanguage: this.appConfig.outputLanguage(),
            provider: provider ?? undefined
        };
    }

    /**
     * Resolves the per-turn cache state — validates / refreshes / recreates
     * via CacheManager, then commits the result back to the kbCacheXxx
     * signals and arms the storage timer. Throws SESSION_EXPIRED if the KB
     * is unrecoverable; phase 2's catch block surfaces that to the user.
     */
    private async ensureCacheValid(): Promise<void> {
        const cacheProvider = this.providerRegistry.getActive();
        if (!cacheProvider) throw new Error('No active LLM provider');
        const resolvedModelId = this.providerRegistry.getActiveModelId();
        const cacheResult = await this.cacheManager.checkCacheAndRefresh({
            provider: cacheProvider,
            providerConfig: this.providerRegistry.getActiveConfig(),
            enableCache: this.providerRegistry.isCacheEnabled(),
            modelId: resolvedModelId,
            systemInstruction: stripSystemMainMarker(this.state.systemInstructionCache()),
            loadedFiles: this.state.loadedFiles(),
            // Pre-computed via the memoized currentKbHash signal — service
            // would otherwise re-walk loadedFiles on every turn just to
            // hash. The signal already invalidates correctly on KB / model
            // / system-instruction changes.
            targetHash: this.state.currentKbHash(),
            currentCacheName: this.state.kbCacheName(),
            currentCacheHash: this.state.kbCacheHash(),
            currentCacheTokens: this.state.kbCacheTokens(),
            currentCacheExpireTime: this.state.kbCacheExpireTime()
        });

        this.state.kbCacheName.set(cacheResult.cacheName);
        this.state.kbCacheExpireTime.set(cacheResult.expireTime);
        this.state.kbCacheHash.set(cacheResult.hash);
        this.state.kbCacheTokens.set(cacheResult.tokens);

        if (cacheResult.sunkUsageTokens > 0) {
            this.chatHistory.recordSunkUsage(cacheResult.sunkUsageTokens, 0, 0);
        }

        if (cacheResult.cacheName) {
            this.cacheManager.startStorageTimer({
                tokens: cacheResult.tokens,
                expireTime: cacheResult.expireTime,
                modelId: resolvedModelId,
                cacheName: cacheResult.cacheName
            });
        } else {
            this.cacheManager.stopStorageTimer();
        }
    }

    /**
     * Switches off a legacy-fork profile (system_main missing the current
     * version marker) before composing a turn. Returns true when a switch
     * happened so the caller can sequence the user-facing notification
     * after other in-flight side effects (e.g. cache refresh) settle.
     * The user's custom IDB content is left untouched.
     */
    private async autoSwitchIfLegacyProfile(): Promise<boolean> {
        if (this.state.activeProfileCompat() !== 'legacy') return false;
        if (this.state.activePromptProfile() === DEFAULT_PROFILE_ID) {
            // Built-in default should always carry the marker; bail rather
            // than loop if the shipped asset is somehow malformed.
            console.warn('[TurnPipeline] Default profile reports legacy compat; check shipped system_prompt.md marker.');
            return false;
        }
        console.warn('[TurnPipeline] Active profile is legacy — auto-switching to default.');
        await this.injection.switchProfile(DEFAULT_PROFILE_ID);
        return true;
    }

    /**
     * Augments the base chat history with the single-call user-message
     * tail (intent injection + protocol_single, both with `{{USER_INPUT}}`
     * substituted). The two-call path skips this method entirely — its
     * augmentation lives in {@link ContextBuilderService.buildResolverContext}
     * and {@link ContextBuilderService.buildNarratorContext}.
     */
    private augmentSingleCallHistory(ctx: BuildContext, baseHistory: LLMContent[], currentIntent: string, lang: string): LLMContent[] {
        const history = baseHistory.slice();

        const injectionContent = this.contextBuilder.intentInjection(ctx, currentIntent);
        if (!injectionContent || history.length === 0) return history;

        const lastMsg = history.pop();
        if (!lastMsg || !lastMsg.parts || typeof lastMsg.parts[0]?.text !== 'string') {
            if (lastMsg) history.push(lastMsg);
            return history;
        }

        const tags = getIntentTags(lang);
        let userInput = lastMsg.parts[0].text;
        let tag = '';
        switch (currentIntent) {
            case GAME_INTENTS.ACTION: tag = tags.ACTION; break;
            case GAME_INTENTS.CONTINUE: tag = tags.CONTINUE; break;
            case GAME_INTENTS.FAST_FORWARD: tag = tags.FAST_FORWARD; break;
            case GAME_INTENTS.SYSTEM: tag = tags.SYSTEM; break;
            case GAME_INTENTS.SAVE: tag = tags.SAVE; break;
        }
        if (tag && !userInput.trim().startsWith(tag)) {
            userInput = tag + userInput;
        }

        console.log(`[TurnPipeline] Injecting Dynamic Prompt for ${currentIntent}`);
        // Function-form replace so a literal `$&` / `$1` in userInput is not
        // interpreted as a backreference pattern. Correction reminder fills
        // first so its rendered text can itself contain `{{USER_INPUT}}`-like
        // sequences without bleeding into the next pass.
        const correctionReminder = this.contextBuilder.renderCorrectionReminder(ctx, this.contextBuilder.getRecentCorrection(ctx));
        const mergedContent = injectionContent
            .replace(/\{\{CORRECTION_REMINDER\}\}/g, () => correctionReminder)
            .replace(/\{\{USER_INPUT\}\}/g, () => userInput);
        const protocolSingle = ctx.dynamicProtocolSingle.replace(/\{\{USER_INPUT\}\}/g, () => userInput);
        const withProtocol = protocolSingle ? `${mergedContent}\n\n${protocolSingle}` : mergedContent;
        const finalContent = this.contextBuilder.wrapUserMessage(withProtocol, history);

        history.push({ role: 'user', parts: [{ text: finalContent }] });
        return history;
    }
}
