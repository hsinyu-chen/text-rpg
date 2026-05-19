import { Injectable, inject } from '@angular/core';
import { LLMContent, LLMProvider, LLMProviderConfig } from '@hcs/llm-core';
import { MatSnackBar } from '@angular/material/snack-bar';

import { GameStateService } from './game-state.service';
import { ChatHistoryService } from './chat-history.service';
import { CacheManagerService } from './cache-manager.service';
import { SessionService } from './session.service';
import { ContextBuilderService, BuildContext } from './context-builder.service';
import { ConfigService } from './config.service';
import { AppConfigStore, AppConfigShape } from './app-config-store';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { stripSystemMainMarker } from './profile-compat';
import { SingleCallTurnEngine } from './turn-engines/single-call-turn-engine.service';
import { TwoCallTurnEngine } from './turn-engines/two-call-turn-engine.service';
import type { TurnEngine } from './turn-engines/turn-engine.interface';
import { InjectionService } from './injection.service';
import { StreamProcessResult } from './stream-processor.service';

import { SessionSave, Scenario } from '../models/types';
import { GAME_INTENTS, STORY_INTENTS } from '../constants/game-intents';
import { I18nService } from '../i18n';
import { DEFAULT_PROFILE_ID } from '../constants/prompt-profiles';

import { SceneBootService } from './scene-boot.service';
import { TurnCommitService, TurnContext, RunTurnOptions } from './turn-commit.service';
import { SaveSettingsStore } from './multi-agent-save/save-settings.store';
import { MultiAgentSaveService } from './multi-agent-save/multi-agent-save.service';
import { SaveProgressTracker } from './multi-agent-save/progress/save-progress-tracker.service';

export type { RunTurnOptions } from './turn-commit.service';

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

/**
 * Orchestrator: owns runTurn's 8-phase pipeline + scene boot + facades.
 * The phase responsibilities are spread across collaborators:
 *   - phases 0-5 (validate / start / cache / compose / execute / finishReason) live here
 *   - context snapshot + single-call history augmentation → ContextBuilderService
 *   - phases 6-8 (correction / commit / persist / auto-resend payload) → TurnCommitService
 *
 * GameEngineService remains the single injection point components reach for —
 * facade methods proxy to ConfigService / SessionService / CacheManagerService /
 * ChatHistoryService so callsites don't need to wire four services.
 */
@Injectable({ providedIn: 'root' })
export class GameEngineService {
    private snackBar = inject(MatSnackBar);
    private state = inject(GameStateService);
    private chatHistory = inject(ChatHistoryService);
    private cacheManager = inject(CacheManagerService);
    private session = inject(SessionService);
    private contextBuilder = inject(ContextBuilderService);
    private configService = inject(ConfigService);
    private singleCallEngine = inject(SingleCallTurnEngine);
    private twoCallEngine = inject(TwoCallTurnEngine);
    private injection = inject(InjectionService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private appConfig = inject(AppConfigStore);
    private sceneBoot = inject(SceneBootService);
    private commitService = inject(TurnCommitService);
    private i18n = inject(I18nService);
    private saveSettings = inject(SaveSettingsStore);
    private multiAgentSave = inject(MultiAgentSaveService);
    private saveProgress = inject(SaveProgressTracker);

    private currentAbortController: AbortController | null = null;

    /** Bootstraps engine subsystems via ConfigService. Call AFTER registering LLM Providers. */
    async init() {
        await this.configService.init();
    }

    // ===== Turn pipeline =====================================================

    /** Live preview payload — mirrors what runTurn would send. */
    getPreviewPayload(userText: string, options?: { intent?: string }) {
        return this.contextBuilder.getPreviewPayload(this.contextBuilder.snapshotForTurn(), userText, options);
    }

    /**
     * Sends a message to the LLM. Phases:
     *   0 validateRunTurnArgs → 1 startTurn → 2 prepareCacheOrAbort →
     *   3 composeRequest → 4 executeTurn → 5 surfaceFinishReason →
     *   6 commitService.applyCorrection → 7 commitService.commitModelMessage →
     *   8 commitService.recordUsageAndPersist → tail: auto-resend microtask
     */
    async sendMessage(userText: string, options?: RunTurnOptions): Promise<void> {
        // Re-entrancy guard: if we're already streaming a turn, dropping
        // through would overwrite this.currentAbortController and orphan the
        // first turn's stream. Auto-resend microtasks fire after phase 8 has
        // flipped status='idle', so this guard never blocks them.
        if (this.state.status() === 'generating') return;
        // Multi-agent save bypasses startTurn, so it never flips status to
        // 'generating'. Without this second guard, an auto-resend / hotkey /
        // agent trigger could race a save-in-progress and corrupt shared
        // context state.
        if (this.saveProgress.isRunning()) return;
        console.log('[GameEngine] sendMessage received with intent:', options?.intent);
        if (!this.validateRunTurnArgs(userText, options)) return;

        // Multi-agent save: independent dispatch path. Bypasses the entire
        // 8-phase chat pipeline — no user message in chat history, no model
        // message, no story-protocol composition. The orchestrator owns its
        // own progress dialog + AutoUpdateDialog open + error surfacing,
        // but route the call through handleTurnError too so a defensive
        // throw (e.g. signal setup error, DI failure) still surfaces via
        // the same snackbar / status='error' path as the chat pipeline.
        if (options?.intent === GAME_INTENTS.SAVE && this.saveSettings.saveMode() === 'multi-agent') {
            // Legacy-fork profiles can be missing the manifest prompt or
            // carry stale schema text; do the same autoswitch the chat
            // pipeline runs before composing a turn. The notification
            // surfaces via the same snackbar path as the legacy chat flow.
            const switchedFromLegacy = await this.autoSwitchIfLegacyProfile();
            if (switchedFromLegacy) {
                this.snackBar.open(
                    this.i18n.translate('ui.LEGACY_PROFILE_AUTOSWITCH'),
                    this.i18n.translate('ui.CLOSE'),
                    { duration: 8000, panelClass: ['snackbar-warning'] },
                );
            }
            try {
                await this.multiAgentSave.run(userText);
            } catch (e: unknown) {
                await this.handleTurnError(e);
            }
            return;
        }

        const turn = await this.startTurn(userText, options);
        if (!(await this.prepareCacheOrAbort(turn))) return;

        try {
            const req = this.composeRequest(turn);
            const result = await this.executeTurn(req, turn);
            this.surfaceFinishReason(result);

            const correction = this.commitService.applyCorrection(result);
            await this.commitService.commitModelMessage(turn, result, correction);
            await this.commitService.recordUsageAndPersist(result);
            this.currentAbortController = null;

            const resend = this.commitService.buildAutoResendPayload(turn, result, correction);
            if (resend) {
                // Microtask placement guarantees the new sendMessage doesn't
                // see itself as re-entrant — the current turn's status flip to
                // 'idle' has already committed. The resend goes through the
                // normal pipeline, so two-call mode produces the corrected
                // story via resolver+narrator (the whole point of the auto-
                // resend pattern).
                queueMicrotask(() => {
                    this.sendMessage(resend.userText, resend.options).catch(err => {
                        // sendMessage has its own try/catch and surfaces user-
                        // facing errors via snackbar + status='error'. Anything
                        // that escapes that net (e.g. push of the empty user
                        // msg failing) lands here. Logging keeps it visible
                        // instead of becoming a silent unhandled rejection;
                        // the system pair stays non-ref-only on failure so the
                        // user can manually retry or delete it.
                        console.error('[GameEngine] Auto-resend after correction failed:', err);
                    });
                });
            }
        } catch (e: unknown) {
            await this.handleTurnError(e);
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

    /**
     * Initializes the story session via local fast-path scene extraction;
     * falls back to LLM generation when no marker is found.
     */
    async startSession() {
        if (!this.state.isConfigured() || this.state.loadedFiles().size === 0) {
            console.log('[GameEngine] startSession aborted: Engine not configured or Knowledge Base is empty.');
            return;
        }
        if (this.state.messages().length > 0) return;

        const result = await this.sceneBoot.tryLocalBoot();
        if (!result.bootedLocally) {
            // Fire-and-forget: callers (e.g. startNewGame, post-load init)
            // resolve as soon as scene-boot finishes; the LLM-fallback turn
            // owns its own status / error surface via sendMessage's catch.
            void this.sendMessage(result.fallbackText, { isHidden: true });
        }
    }

    // ===== Phase helpers (orchestrator-local) ================================

    /** Phase 0: reject empty text on intents that demand input. */
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

        await this.chatHistory.updateMessages(prev => [...prev, {
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
     * autoswitch note prepended when applicable) and returns false.
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
            const autoswitchPrefix = turn.switchedFromLegacy
                ? `${this.i18n.translate('ui.LEGACY_PROFILE_AUTOSWITCH')}\n\n`
                : '';
            const errorCore = sessionExpired
                ? this.i18n.translate('ui.SESSION_EXPIRED_KB_RELOAD')
                : this.i18n.translate('ui.SNACK_ERROR_PREFIX', { error: e instanceof Error ? e.message : this.i18n.translate('ui.CONN_ERROR') });
            this.snackBar.open(autoswitchPrefix + errorCore, this.i18n.translate('ui.CLOSE'), {
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
        const buildCtx = this.contextBuilder.snapshotForTurn();
        const baseHistory = this.contextBuilder.getLLMHistory(buildCtx, turn.forceFullContext);
        const lang = buildCtx.outputLanguage || 'default';

        if (turn.switchedFromLegacy) {
            this.snackBar.open(
                this.i18n.translate('ui.LEGACY_PROFILE_AUTOSWITCH'),
                this.i18n.translate('ui.CLOSE'),
                { duration: 8000, panelClass: ['snackbar-warning'] },
            );
        }

        // Two-call only applies to story intents — SYSTEM/SAVE bypass the
        // resolver/narrator split (they have no atomic-action semantics).
        const useTwoCall = buildCtx.engineMode === 'two-call' && (STORY_INTENTS as string[]).includes(turn.currentIntent);
        let history: LLMContent[];
        let engine: TurnEngine;
        if (useTwoCall) {
            history = baseHistory;
            engine = this.twoCallEngine;
            console.log(`[GameEngine] Dispatching two-call engine for intent ${turn.currentIntent}`);
        } else {
            history = this.contextBuilder.augmentSingleCallHistory(buildCtx, baseHistory, turn.currentIntent, lang);
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
            updateMessages: (updater) => this.chatHistory.updateMessages(updater),
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
        this.snackBar.open(
            `${this.i18n.translate('ui.STOP_REASON_PREFIX')} ${reason}`,
            this.i18n.translate('ui.CLOSE'),
            { duration: 8000, panelClass: ['snackbar-warning'] },
        );
    }

    /** Catches errors thrown anywhere in phases 3-tail. AbortError is the silent path. */
    private async handleTurnError(e: unknown): Promise<void> {
        this.currentAbortController = null;
        if (e instanceof Error && e.name === 'AbortError') {
            console.log('[GameEngine] Generation aborted.');
            // Reset status — without this, an abort that didn't come from
            // stopGeneration() (e.g. external signal cancellation when a
            // bridge HTTP read times out mid-stream) leaves state.status
            // stuck on 'generating' and every subsequent sendMessage is
            // rejected as 'busy' until a full page reload.
            this.state.status.set('idle');
            return;
        }
        console.error(e);
        this.state.status.set('error');

        const errMsg = (e instanceof Error) ? e.message : this.i18n.translate('ui.CONN_ERROR');
        const errorContent = this.i18n.translate('ui.ERR_PREFIX', { error: errMsg });
        await this.chatHistory.updateMessages(prev => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.role === 'model') {
                last.isThinking = false;
                last.content = errorContent;
                last.parts = [{ text: last.content }];
            } else {
                updated.push({ id: crypto.randomUUID(), role: 'model', content: errorContent, isRefOnly: true });
            }
            return updated;
        });
        this.snackBar.open(
            this.i18n.translate('ui.GEN_FAILED', { error: errMsg }),
            this.i18n.translate('ui.CLOSE'),
            { duration: 5000, panelClass: ['snackbar-error'] },
        );
        // Persist the error message to the Book so it survives reload — the
        // chat-history IDB store alone isn't the source of truth on session
        // load. Awaited (consistent with the round-11 lockstep contract); the
        // local try/catch keeps a save failure here from re-throwing out of
        // an already-running error handler.
        try {
            await this.session.saveCurrentSessionToBook();
        } catch (err) {
            console.error('[GameEngine] saveCurrentSessionToBook in error path failed:', err);
        }
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
            // Fire-and-forget: sunk_usage_history lives in its own IDB store and
            // isn't part of the chat/book lockstep contract.
            void this.chatHistory.recordSunkUsage(cacheResult.sunkUsageTokens, 0, 0);
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
            console.warn('[GameEngine] Default profile reports legacy compat; check shipped system_prompt.md marker.');
            return false;
        }
        console.warn('[GameEngine] Active profile is legacy — auto-switching to default.');
        await this.injection.switchProfile(DEFAULT_PROFILE_ID);
        return true;
    }

    // ===== Config facades ====================================================

    saveConfig(genConfig: Partial<AppConfigShape>) { return this.configService.saveConfig(genConfig); }
    importConfig(config: unknown) { return this.configService.importConfig(config); }

    // ===== Session facades ===================================================

    exportSession(): SessionSave { return this.session.exportSession(); }
    importSession(save: SessionSave) { return this.session.importSession(save); }
    importFiles(files: Map<string, string>) { return this.session.importFiles(files); }
    updateSingleFile(filePath: string, content: string) { return this.session.updateSingleFile(filePath, content); }
    saveCurrentSessionToBook() { return this.session.saveCurrentSessionToBook(); }

    /**
     * Loads files from a directory and initializes the Knowledge Base.
     * Defaults to bumpTimestamp=true: callers reaching the engine layer are
     * user-driven actions (button click, post-LLM-update reload, folder pick),
     * which represent real KB-content change. Programmatic re-reads that are
     * NOT a real change (startup hydration, language toggle) call
     * session.loadFiles directly with bumpTimestamp=false instead.
     */
    loadFiles(pickFolder = true, bumpTimestamp = true) {
        return this.session.loadFiles(pickFolder, bumpTimestamp);
    }

    /** Completely wipes all local game progress. */
    wipeLocalSession() { return this.session.unloadCurrentSession(false); }

    async startNewGame(profile: {
        name: string,
        faction: string,
        background: string,
        interests: string,
        appearance: string
    }, scenario: Scenario) {
        await this.session.startNewGame(profile, scenario);
        await this.startSession();
    }

    // ===== Cache facades =====================================================

    cleanupCache() { return this.cacheManager.cleanupCache(); }
    clearAllServerCaches() { return this.cacheManager.clearAllServerCaches(); }
    releaseCache() { return this.cacheManager.releaseCache(); }

    // ===== Chat history facades ==============================================
    // ChatHistoryService persists the book itself; these are 1-line proxies
    // so callsites keep a single injection point (GameEngineService).

    updateMessageContent(id: string, newContent: string) { return this.chatHistory.updateMessageContent(id, newContent); }
    updateMessageLogs(id: string, type: 'inventory' | 'quest' | 'world' | 'character', logs: string[]) { return this.chatHistory.updateMessageLogs(id, type, logs); }
    updateMessageSummary(id: string, summary: string) { return this.chatHistory.updateMessageSummary(id, summary); }
    updateMessageCorrection(id: string, correction: string) { return this.chatHistory.updateMessageCorrection(id, correction); }
    deleteMessage(id: string) { return this.chatHistory.deleteMessage(id); }
    deleteMessages(ids: string[]) { return this.chatHistory.deleteMessages(ids); }
    deleteFrom(id: string) { return this.chatHistory.deleteFrom(id); }
    rewindTo(messageId: string) { return this.chatHistory.rewindTo(messageId); }
    toggleRefOnly(id: string) { return this.chatHistory.toggleRefOnly(id); }
    async clearHistory() {
        // Abort any in-flight generation first; otherwise the stream keeps
        // running, consumes tokens, and may write to the freshly-cleared
        // history. stopGeneration also sets status='idle' as a side effect.
        this.stopGeneration();
        await this.chatHistory.clearHistory();
    }
}
