import { Injectable, inject } from '@angular/core';
import type { LLMContent } from '@hcs/llm-core';

import { CostService } from './cost.service';
import { GameStateService } from './game-state.service';
import { ChatHistoryService } from './chat-history.service';

import { CacheManagerService } from './cache-manager.service';
import { SessionService } from './session.service';
import { ContextBuilderService, BuildContext } from './context-builder.service';
import { ConfigService } from './config.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMProviderCapabilities } from '@hcs/llm-core';
import { stripSystemMainMarker } from './profile-compat';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ChatMessage, SessionSave, ExtendedPart, Scenario } from '../models/types';

import { GAME_INTENTS } from '../constants/game-intents';
import {
    getAdultDeclaration,
    getIntentTags,
    getSectionHeaders,
    getUIStrings
} from '../constants/engine-protocol';
import { LOCALES } from '../constants/locales';
import { SingleCallTurnEngine } from './turn-engines/single-call-turn-engine.service';
import { TwoCallTurnEngine } from './turn-engines/two-call-turn-engine.service';
import { STORY_INTENTS } from '../constants/game-intents';
import type { TurnEngine } from './turn-engines/turn-engine.interface';
import { InjectionService } from './injection.service';
import { DEFAULT_PROFILE_ID } from '../constants/prompt-profiles';

@Injectable({
    providedIn: 'root'
})
export class GameEngineService {
    private cost = inject(CostService);
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

    private currentAbortController: AbortController | null = null;

    /**
     * Calculates the estimated cost of a single turn based on token usage.
     * @param turnUsage Object containing prompt, candidates, and cached tokens.
     * @returns The calculated cost in USD.
     */
    private calculateTurnCost(turnUsage: { prompt: number, candidates: number, cached?: number }) {
        return this.cost.calculateTurnCost(turnUsage, this.state.config()?.modelId);
    }

    constructor() {
        // Effects moved to ConfigService.
    }

    /**
     * Initializes the service by loading configuration and usage stats from localStorage.
     * Call this AFTER registering LLM Providers.
     */
    public init() {
        this.configService.init();
    }


    /**
     * Saves application configuration to localStorage and updates the engine state.
     * @param apiKey The Gemini API Key.
     * @param modelId The Gemini Model ID to use.
     * @param genConfig Generation parameters (temperature, etc.) and UI settings.
     */
    async saveConfig(genConfig: {
        fontSize?: number,
        fontFamily?: string,
        enableCache?: boolean,
        exchangeRate?: number,
        currency?: string,
        enableConversion?: boolean,
        screensaverType?: 'invaders' | 'code',
        outputLanguage?: string,
        idleOnBlur?: boolean,
        thinkingLevelStory?: string,
        thinkingLevelGeneral?: string,
        engineMode?: 'single' | 'two-call'
    }) {
        await this.configService.saveConfig(genConfig);
    }

    /**
     * Imports configuration from a plain object (e.g. from JSON).
     * @param config The configuration object to restore.
     */
    importConfig(config: unknown) {
        this.configService.importConfig(config);
    }

    /**
     * Loads chat history from local persistent storage.
     */
    /**
     * Loads chat history from local persistent storage.
     */



    /**
     * Exports the current session state for saving.
     * @returns A SessionSave object containing the current state.
     */
    exportSession(): SessionSave {
        return this.session.exportSession();
    }

    /**
     * Imports a saved session state.
     * @param save The SessionSave to restore.
     */
    async importSession(save: SessionSave) {
        await this.session.importSession(save);
    }

    /**
     * Bulk imports files into the persistent store (IndexedDB) and reloads the engine state.
     * Use this when fetching files from Cloud or other non-local sources.
     */
    async importFiles(files: Map<string, string>) {
        await this.session.importFiles(files);
    }

    /**
     * Updates a single file in storage and refreshes the loadedFiles signal.
     * Use this after applying auto-updates to ensure sync sees the changes.
     * @param filePath The file path/name.
     * @param content The new content.
     */
    async updateSingleFile(filePath: string, content: string): Promise<void> {
        await this.session.updateSingleFile(filePath, content);
    }

    /**
     * Persists the current in-memory session state into the active Book entity.
     * Required after UI-driven file edits so changes survive reload/unload.
     */
    async saveCurrentSessionToBook(): Promise<void> {
        await this.session.saveCurrentSessionToBook();
    }

    /**
     * Loads files from a directory and initializes the Knowledge Base.
     * Defaults to bumpTimestamp=true: callers reaching the engine layer are
     * user-driven actions (button click, post-LLM-update reload, folder pick),
     * which represent real KB-content change. Programmatic re-reads that are
     * NOT a real change (startup hydration, language toggle) call
     * session.loadFiles directly with bumpTimestamp=false instead.
     * @param pickFolder Whether to prompt the user to pick a new folder.
     * @param bumpTimestamp Whether to bump book.lastActiveAt for sync.
     */
    async loadFiles(pickFolder = true, bumpTimestamp = true) {
        await this.session.loadFiles(pickFolder, bumpTimestamp);
    }

    /**
     * Cleans up the active context cache on the server and resets local cache-related signals.
     */
    async cleanupCache() {
        await this.cacheManager.cleanupCache();
    }

    /**
     * Validates if the current Knowledge Base (Cache or File) is still available on the server.
     * If not, attempts to restore it from local files (Self-healing).
     * @throws Error with 'SESSION_EXPIRED' if context is lost and cannot be recovered.
     */


    /**
     * Clears all server-side caches and uploaded files, and resets the local session state.
     * @returns The number of caches deleted.
     */
    async clearAllServerCaches() {
        return this.cacheManager.clearAllServerCaches();
    }

    /**
     * Manually releases the active context cache on the server while preserving chat history.
     */
    async releaseCache() {
        await this.cacheManager.releaseCache();
    }

    /**
     * Completely wipes all local game progress, including IndexedDB stores and signals.
     */
    async wipeLocalSession() {
        await this.session.unloadCurrentSession(false);
    }

    /**
     * Initializes a new game session using scenario templates.
     * @param profile User-defined character profile.
     */
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

    /**
     * Initializes the story session by either extracting the last scene from '2.劇情綱要.md'
     * or prompting the AI to start the story.
     */
    async startSession() {
        if (!this.state.isConfigured() || this.state.loadedFiles().size === 0) {
            console.log('[GameEngine] startSession aborted: Engine not configured or Knowledge Base is empty.');
            return;
        }
        if (this.state.messages().length === 0) {
            const lang = this.state.config()?.outputLanguage || 'default';
            const ui = getUIStrings(lang);
            const introText = ui.INTRO_TEXT;

            // Optimization: Try to extract last scene locally to save API call and tokens
            // Optimization: Try to extract last scene locally to save API call and tokens
            // Find the loaded Story Outline file (checking all known locale variants)
            const potentialOutlineNames = new Set(Object.values(LOCALES).map(l => l.coreFilenames.STORY_OUTLINE));
            let fileName = '';
            let content: string | undefined;

            for (const name of potentialOutlineNames) {
                if (this.state.loadedFiles().has(name)) {
                    fileName = name;
                    content = this.state.loadedFiles().get(name);
                    break;
                }
            }

            let lastScene = '';

            if (content) {
                // Support flexible markers: # last_scene, **last_scene**:, last_scene: etc.
                // Regex looks for variations of 'last_scene' followed by optional punctuation and then captures everything to EOF
                const regex = /(?:^|\n)(?:[#*_\s]*last[_-]?scene[#*_\s]*[:：]?\s*)([\s\S]*)$/i;
                const match = content.match(regex);
                if (match && match[1]) {
                    lastScene = match[1].trim();
                }
            }

            // Detect language from file name to ensure Adult Declaration matches scenario language
            const matchedLocale = Object.values(LOCALES).find(l => l.coreFilenames.STORY_OUTLINE === fileName);
            const langId = matchedLocale ? matchedLocale.id : (this.state.config()?.outputLanguage || 'default');

            if (lastScene) {
                console.log('[GameEngine] Local Initialization: Extracted last_scene from', fileName);
                const userMsgId = crypto.randomUUID();
                const modelMsgId = crypto.randomUUID();

                const declaration = this.state.config()?.enableAdultDeclaration === false ? '' : getAdultDeclaration(langId);

                const ui = getUIStrings(langId);
                this.updateMessages(prev => [
                    ...prev,
                    {
                        id: userMsgId,
                        role: 'user',
                        content: introText,
                        parts: [{ text: introText }],
                        isHidden: true
                    },
                    {
                        id: modelMsgId,
                        role: 'model',
                        content: declaration + lastScene,
                        parts: [{ text: declaration + lastScene }],
                        analysis: ui.LOCAL_INIT_ANALYSIS
                    }
                ]);
                await this.session.saveCurrentSessionToBook();
            } else if (content) {
                // No last_scene marker — try extracting ## 開始場景 / ## Start Scene (generated world files)
                const startSceneHeader = getSectionHeaders(langId).START_SCENE;
                if (content.includes(startSceneHeader)) {
                    lastScene = content.split(startSceneHeader)[1].split(/\n---|\n##/)[0].trim();
                }

                if (lastScene) {
                    console.log('[GameEngine] Local Initialization: Extracted start scene from', fileName);
                    const userMsgId = crypto.randomUUID();
                    const modelMsgId = crypto.randomUUID();
                    const declaration = this.state.config()?.enableAdultDeclaration === false ? '' : getAdultDeclaration(langId);
                    const uiStrings = getUIStrings(langId);
                    this.updateMessages(prev => [
                        ...prev,
                        { id: userMsgId, role: 'user', content: introText, parts: [{ text: introText }], isHidden: true },
                        { id: modelMsgId, role: 'model', content: declaration + lastScene, parts: [{ text: declaration + lastScene }], analysis: uiStrings.LOCAL_INIT_ANALYSIS }
                    ]);
                    await this.session.saveCurrentSessionToBook();
                } else {
                    console.log('[GameEngine] Local Initialization Failed: No marker found or file empty. Falling back to LLM generation.');
                    this.sendMessage(introText, { isHidden: true });
                }
            } else {
                console.log('[GameEngine] Local Initialization Failed: No marker found or file empty. Falling back to LLM generation.');
                this.sendMessage(introText, { isHidden: true });
            }
        }
    }

    /**
     * Constructs the Part array for the Knowledge Base content from a file map.
     * @param files Map of file paths to content.
     * @returns Array of Part objects containing the file contents.
     */


    /**
     * Constructs the JSON payload that will be sent to the Gemini API for preview purposes.
     * @param userText The user's input text.
     * @param options Optional intent and other metadata.
     * @returns The constructed payload object.
     */
    getPreviewPayload(userText: string, options?: { intent?: string }) {
        return this.contextBuilder.getPreviewPayload(this.snapshotBuildContext(), userText, options);
    }

    /**
     * Captures every signal the context builder reads, in one shot. The
     * returned object is what each ContextBuilder method now operates on
     * — caller never re-enters state mid-call. Used by both `sendMessage`
     * (engine path) and `getPreviewPayload` (chat-input live preview).
     */
    private snapshotBuildContext(): BuildContext {
        const config = this.state.config();
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
            smartContextTurns: config?.smartContextTurns ?? 10,
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
            engineMode: config?.engineMode ?? 'single',
            modelId: config?.modelId,
            outputLanguage: config?.outputLanguage,
            provider: provider ?? undefined
        };
    }

    /**
     * Sends a message to the Gemini API and updates the chat history in real-time.
     * Handles streaming responses, JSON parsing, and automatic archiving of old turns.
     * @param userText The user's input text.
     * @param options Optional flags for hidden messages or specific intents.
     */
    async sendMessage(userText: string, options?: {
        isHidden?: boolean,
        intent?: string,
        // Optional user-supplied ideal_outcome for two-call resolver. When non-empty,
        // ContextBuilder injects it into the resolver's protocol via the
        // {{IDEAL_OUTCOME_CONSTRAINT}} slot on the next turn. Carried on the user
        // message so it persists across reloads / rewinds.
        userIdealOutcome?: string,
        // Set when this call is the auto-resend triggered by a `<系統>` correction.
        // Its presence drives post-turn cleanup: the system pair + the original
        // (now-failed) action user message become ref-only, and the correction
        // string is transplanted onto the freshly-committed corrective story
        // model message so Layer 1 (stateUpdates summary) keeps propagating it.
        isCorrectionResend?: {
            systemUserId: string;
            systemModelId: string;
            oldStoryUserId: string;
            correctionText: string;
        }
    }) {
        console.log('[GameEngine] sendMessage received with intent:', options?.intent);
        // Allow empty text for CONTINUE and SAVE intents
        const isActionOrSystem = !options?.intent || options.intent === GAME_INTENTS.ACTION || options.intent === GAME_INTENTS.SYSTEM || options.intent === GAME_INTENTS.FAST_FORWARD;
        if (!userText.trim() && isActionOrSystem) return;

        // Force full context for <存檔> intent regardless of UI setting
        const forceFullContext = options?.intent === GAME_INTENTS.SAVE;

        // Switch off any legacy-fork profile before composing a turn.
        const switchedFromLegacy = await this.autoSwitchIfLegacyProfile();

        const parts: ExtendedPart[] = [{ text: userText }];
        const userMsgId = crypto.randomUUID();

        // 1. Immediately update UI & Storage
        const userIdealOutcome = options?.userIdealOutcome?.trim() || undefined;
        this.updateMessages(prev => [...prev, {
            id: userMsgId,
            role: 'user',
            content: userText,
            parts,
            isRefOnly: false,
            isHidden: options?.isHidden,
            intent: options?.intent,
            userIdealOutcome
        }]);

        this.state.status.set('generating');

        // 2. Ensure cache is valid before generating
        try {
            // ALWAYS pass clean instruction to CacheManager.
            // If CacheManager needs to create/refresh an explicit cache, it will use this as header.
            // KB content is already handled by CacheManager via fileParts in createCache.
            // CacheManager always wants the bare system prompt (no KB body) — it
            // owns the KB injection itself via fileParts. Inlined here rather
            // than going through ContextBuilder so we don't have to snapshot
            // the build context before cache validation runs (cache refresh
            // can mutate kbCacheName, and we want the post-refresh value in
            // the snapshot).
            await this.cacheManager.checkCacheAndRefresh(stripSystemMainMarker(this.state.systemInstructionCache()));
        } catch (e: unknown) {
            // If we just auto-switched profiles, fold that note into the
            // error message so the user understands the silent state change
            // before retrying.
            const lang = this.state.config()?.outputLanguage;
            const ui = getUIStrings(lang);
            const autoswitchPrefix = switchedFromLegacy ? `${ui.LEGACY_PROFILE_AUTOSWITCH}\n\n` : '';
            if (e instanceof Error && e.message === 'SESSION_EXPIRED') {
                this.snackBar.open(autoswitchPrefix + 'Session Expired: Please reload your Knowledge Base folder to continue.', 'Close', {
                    duration: 10000,
                    panelClass: ['snackbar-error']
                });
            } else {
                this.snackBar.open(autoswitchPrefix + `Error: ${e instanceof Error ? e.message : 'Unknown error during cache refresh'}`, 'Close', {
                    duration: 5000,
                    panelClass: ['snackbar-error']
                });
            }
            this.state.status.set('idle');
            return;
        }

        try {
            // Snapshot once. Every signal read for the rest of this turn — both
            // the context builder calls below and the engine's downstream
            // resolver/narrator calls — operates on this frozen view, so a
            // mid-turn config edit / profile switch / message append cannot
            // cause two halves of the same turn to disagree.
            const buildCtx = this.snapshotBuildContext();

            const baseHistory = this.contextBuilder.getLLMHistory(buildCtx, forceFullContext);

            const currentIntent = options?.intent || GAME_INTENTS.ACTION;
            const lang = buildCtx.outputLanguage || 'default';
            const engineMode = buildCtx.engineMode;

            // Notify the user about a legacy-profile auto-switch only once
            // the cache refresh has succeeded — otherwise a cache error
            // snackbar would replace this one before they read it.
            if (switchedFromLegacy) {
                const ui = getUIStrings(lang);
                this.snackBar.open(ui.LEGACY_PROFILE_AUTOSWITCH, ui.CLOSE, {
                    duration: 8000,
                    panelClass: ['snackbar-warning']
                });
            }

            // Two-call only applies to story intents — SYSTEM/SAVE bypass the
            // resolver/narrator split (they have no atomic-action semantics).
            const useTwoCall = engineMode === 'two-call' && (STORY_INTENTS as string[]).includes(currentIntent);

            let history: LLMContent[];
            let engine: TurnEngine;

            if (useTwoCall) {
                history = baseHistory;
                engine = this.twoCallEngine;
                console.log(`[GameEngine] Dispatching two-call engine for intent ${currentIntent}`);
            } else {
                history = this.augmentSingleCallHistory(buildCtx, baseHistory, currentIntent, lang);
                engine = this.singleCallEngine;
            }

            this.currentAbortController = new AbortController();
            const abortSignal = this.currentAbortController.signal;

            const modelMsgId = crypto.randomUUID();

            // Resolve the four engine-runtime fields off the same snapshot.
            // The engine never inspects provider capabilities or cache state
            // for the include/omit-KB decision; that's done here.
            const provider = buildCtx.provider;
            if (!provider) throw new Error('No active LLM provider');
            const providerConfig = this.providerRegistry.getActiveConfig();
            const cachedContentName = buildCtx.kbCacheName || undefined;
            const omitKB = this.contextBuilder.shouldOmitKbFromSystemInstruction(buildCtx);
            const systemInstruction = this.contextBuilder.getEffectiveSystemInstruction(buildCtx, !omitKB);

            const result = await engine.runTurn({
                history,
                intent: currentIntent,
                outputLanguage: lang,
                modelMsgId,
                signal: abortSignal,
                updateMessages: (updater) => this.updateMessages(updater),
                provider,
                providerConfig,
                cachedContentName,
                systemInstruction,
                buildContext: buildCtx
            });

            // Extract results
            const {
                finalAnalysis,
                finalStory,
                finalSummary,
                finalCharacterLog,
                finalInventoryLog,
                finalQuestLog,
                finalWorldLog,
                correction,
                turnUsage,
                capturedFCs,
                capturedThoughtSignature,
                finalThought,
                finalFinishReason,
                contextTokens
            } = result;

            // Show stop reason notification if not normal
            if (finalFinishReason) {
                const normalizedReason = finalFinishReason.toLowerCase();
                if (normalizedReason !== 'stop' && normalizedReason !== 'null') {
                    const ui = getUIStrings(this.state.config()?.outputLanguage);
                    this.snackBar.open(`${ui.STOP_REASON_PREFIX || 'Model Stopped:'} ${finalFinishReason}`, ui.CLOSE, {
                        duration: 8000,
                        panelClass: ['snackbar-warning']
                    });
                }
            }

            // Correction Handling
            const isCorrection = !!correction;
            let correctedIntent: string | undefined;
            let oldStoryUserId: string | undefined;
            let oldStoryUserContent: string | undefined;
            let oldStoryUserIdealOutcome: string | undefined;
            if (isCorrection) {
                const storyIntents = [GAME_INTENTS.ACTION, GAME_INTENTS.CONTINUE, GAME_INTENTS.FAST_FORWARD];
                console.log('[GameEngine] Correction detected:', correction);
                this.updateMessages(prev => {
                    const updated = [...prev];
                    for (let i = updated.length - 2; i >= 0; i--) {
                        const msg = updated[i];
                        if (msg.role === 'model' && !msg.isRefOnly && msg.intent && (storyIntents as string[]).includes(msg.intent)) {
                            updated[i] = { ...msg, isRefOnly: true };
                            correctedIntent = msg.intent;
                            // The user message paired with this old story model is at i-1.
                            // Guard the index explicitly so a malformed history starting
                            // with a model message doesn't trip an out-of-bounds read.
                            if (i > 0) {
                                const paired = updated[i - 1];
                                if (paired.role === 'user') {
                                    oldStoryUserId = paired.id;
                                    oldStoryUserContent = paired.content;
                                    oldStoryUserIdealOutcome = paired.userIdealOutcome;
                                }
                            }
                            console.log('[GameEngine] Marked old story model ref-only:', msg.id);
                            break;
                        }
                    }
                    return updated;
                });
            }



            // Single update covers both:
            //  (a) committing the just-finished model message (always)
            //  (b) post-resend cleanup when this turn was triggered as a
            //      correction resend — ref-only the system pair + original
            //      action user msg, and transplant the correction string onto
            //      the freshly-committed corrective story model so Layer 1
            //      stateUpdates keeps propagating the rule going forward.
            const resendOpts = !isCorrection ? options?.isCorrectionResend : undefined;
            this.updateMessages(prev => prev.map((m, i) => {
                const isLast = i === prev.length - 1;
                if (isLast && m.role === 'model') {
                    const committed: ChatMessage = {
                        ...m,
                        isThinking: false,
                        parts: ((): ExtendedPart[] => {
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
                            return parts;
                        })(),
                        content: finalStory,
                        analysis: finalAnalysis,
                        thought: finalThought,
                        summary: finalSummary,
                        character_log: finalCharacterLog,
                        inventory_log: finalInventoryLog,
                        quest_log: finalQuestLog,
                        world_log: finalWorldLog,
                        usage: turnUsage,
                        contextTokens,
                        // intent stays the user's original (SYSTEM for correction-declaration
                        // turns, story intent for normal turns). The auto-resend below
                        // produces a separate story-intent turn — we no longer fuse the
                        // correction declaration into the corrected story slot inline.
                        intent: currentIntent,
                        // For correction-resend, transplant the prior system model's
                        // correction string here so Layer 1 keeps the rule alive after
                        // the system pair becomes ref-only below.
                        correction: resendOpts ? resendOpts.correctionText : (isCorrection ? correction : m.correction)
                    };
                    return committed;
                }
                if (resendOpts && (m.id === resendOpts.systemUserId || m.id === resendOpts.systemModelId || m.id === resendOpts.oldStoryUserId)) {
                    return { ...m, isRefOnly: true };
                }
                return m;
            }));

            // Update local state with fresh usage stats
            // Robust calculation: prompt may be total or fresh-only depending on provider/timings.
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

            this.state.tokenUsage.update(prev => {
                return {
                    freshInput: prev.freshInput + fresh,
                    cached: prev.cached + (turnUsage.cached || 0),
                    output: prev.output + (turnUsage.candidates || 0),
                    total: prev.total + (turnUsage.prompt || 0) + (turnUsage.candidates || 0)
                };
            });

            console.log(`[GameEngine] Turn Usage Breakdown:
- FRESH Input (Not in Cache): ${fresh.toLocaleString()} tokens
  (Includes Chat History + Tool Outputs + System Instructions not in KB)
- CACHED Input (Knowledge Base): ${(turnUsage.cached || 0).toLocaleString()} tokens
- Output: ${turnUsage.candidates.toLocaleString()} tokens
- Turn Cost: $${turnCost.toFixed(5)}`);

            // Auto-save current session to update lastActiveAt and stats in the book list
            await this.session.saveCurrentSessionToBook();

            this.state.status.set('idle');
            this.currentAbortController = null;

            // Auto-resend after a `<系統>` correction was accepted. Microtask
            // queue ensures this runs after the current turn's status flip to
            // 'idle' so the new sendMessage doesn't see itself as re-entrant.
            // The resend runs through the normal engine, which means two-call
            // mode produces the corrected story via resolver+narrator (the
            // whole point of the auto-resend pattern). Cleanup of the system
            // pair + correction transplant happens inside that next turn's
            // `isCorrectionResend` post-commit hook above.
            if (isCorrection && correctedIntent && oldStoryUserId && oldStoryUserContent !== undefined) {
                const resendOpts = {
                    intent: correctedIntent,
                    // Carry the original action's user-supplied ideal_outcome through
                    // the resend so the corrective resolver run keeps the same
                    // constraint (otherwise it silently reverts to full inference,
                    // which can re-introduce the very mismatch the correction fixed).
                    userIdealOutcome: oldStoryUserIdealOutcome,
                    isCorrectionResend: {
                        systemUserId: userMsgId,
                        systemModelId: modelMsgId,
                        oldStoryUserId,
                        correctionText: correction
                    }
                };
                queueMicrotask(() => {
                    this.sendMessage(oldStoryUserContent!, resendOpts).catch(err => {
                        // sendMessage has its own try/catch and surfaces user-facing
                        // errors via snackbar + status='error'. Anything that escapes
                        // that net (push of the empty user msg failing, etc.) lands
                        // here. Logging keeps it visible instead of becoming a silent
                        // unhandled rejection. The system pair stays non-ref-only on
                        // failure so the user can manually retry or delete it.
                        console.error('[GameEngine] Auto-resend after correction failed:', err);
                    });
                });
            }
        } catch (e: unknown) {
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

            const ui = getUIStrings(this.state.config()?.outputLanguage);
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

                // Show UI Toast
                this.snackBar.open(ui.GEN_FAILED.replace('{error}', errMsg), ui.CLOSE, {
                    duration: 5000,
                    panelClass: ['snackbar-error']
                });
                return updated;
            });
        }
    }


    /**
     * @category Chat History Delegates
     */

    async updateMessageContent(id: string, newContent: string) {
        this.chatHistory.updateMessageContent(id, newContent);
        await this.session.saveCurrentSessionToBook();
    }

    async updateMessageLogs(id: string, type: 'inventory' | 'quest' | 'world' | 'character', logs: string[]) {
        this.chatHistory.updateMessageLogs(id, type, logs);
        await this.session.saveCurrentSessionToBook();
    }

    async updateMessageSummary(id: string, summary: string) {
        this.chatHistory.updateMessageSummary(id, summary);
        await this.session.saveCurrentSessionToBook();
    }

    async updateMessageCorrection(id: string, correction: string) {
        this.chatHistory.updateMessageCorrection(id, correction);
        await this.session.saveCurrentSessionToBook();
    }

    async deleteMessage(id: string) {
        this.chatHistory.deleteMessage(id);
        await this.session.saveCurrentSessionToBook();
    }

    async deleteMessages(ids: string[]) {
        if (ids.length === 0) return;
        for (const id of ids) {
            this.chatHistory.deleteMessage(id);
        }
        await this.session.saveCurrentSessionToBook();
    }

    async deleteFrom(id: string) {
        this.chatHistory.deleteFrom(id);
        await this.session.saveCurrentSessionToBook();
    }

    async rewindTo(messageId: string) {
        this.chatHistory.rewindTo(messageId);
        await this.session.saveCurrentSessionToBook();
    }

    async toggleRefOnly(id: string) {
        this.chatHistory.toggleRefOnly(id);
        await this.session.saveCurrentSessionToBook();
    }

    async clearHistory() {
        await this.chatHistory.clearHistory();
        await this.session.saveCurrentSessionToBook();
    }

    private updateMessages(updater: (prev: ChatMessage[]) => ChatMessage[]) {
        this.chatHistory.updateMessages(updater);
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

        console.log(`[GameEngine] Injecting Dynamic Prompt for ${currentIntent}`);
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

    /**
     * Aborts the current generation process.
     */
    stopGeneration() {
        if (this.currentAbortController) {
            this.currentAbortController.abort();
            this.currentAbortController = null;
        }
        this.state.status.set('idle');
    }

    /**
     * Constructs the chat history in a provider-agnostic format.
     * Handles smart context consolidation and Knowledge Base injection.
     * @returns Array of Content objects.
     */
    /**
     * Constructs the chat history in a provider-agnostic format.
     * Handles smart context consolidation and Knowledge Base injection.
     * @returns Array of Content objects.
     */


}
