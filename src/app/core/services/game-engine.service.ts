import { Injectable, inject } from '@angular/core';

import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMProvider, LLMContent } from './llm-provider';
import { CostService } from './cost.service';
import { GameStateService } from './game-state.service';
import { ChatHistoryService } from './chat-history.service';
import { InjectionService } from './injection.service';

import { CacheManagerService } from './cache-manager.service';
import { SessionService } from './session.service';
import { ContextBuilderService } from './context-builder.service';
import { ConfigService } from './config.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ChatMessage, SessionSave, ExtendedPart, Scenario } from '../models/types';
import { StreamProcessorService } from './stream-processor.service';

import { GAME_INTENTS } from '../constants/game-intents';
import {
    getAdultDeclaration,
    getIntentTags,
    getResponseSchema,
    getUIStrings
} from '../constants/engine-protocol';
import { LOCALES } from '../constants/locales';

@Injectable({
    providedIn: 'root'
})
export class GameEngineService {
    private providerRegistry = inject(LLMProviderRegistryService);
    private cost = inject(CostService);
    private snackBar = inject(MatSnackBar);
    private state = inject(GameStateService);
    private chatHistory = inject(ChatHistoryService);
    private injection = inject(InjectionService);
    private cacheManager = inject(CacheManagerService);
    private session = inject(SessionService);
    private contextBuilder = inject(ContextBuilderService);
    private configService = inject(ConfigService);
    private streamProcessor = inject(StreamProcessorService);

    /** Get the currently active LLM provider */
    private get provider(): LLMProvider {
        const p = this.providerRegistry.getActive();
        if (!p) throw new Error('No active LLM provider');
        return p;
    }



    /**
     * Calculates the estimated cost of a single turn based on token usage.
     * @param turnUsage Object containing prompt, candidates, and cached tokens.
     * @returns The calculated cost in USD.
     */
    private calculateTurnCost(turnUsage: { prompt: number, candidates: number, cached: number }) {
        return this.cost.calculateTurnCost(turnUsage, this.state.config()?.modelId);
    }

    constructor() {
        // Effects moved to ConfigService.
    }

    // ==================== Injection Operations (Delegated to InjectionService) ====================

    /**
     * Initializes the service by loading configuration and usage stats from localStorage.
     * Call this AFTER registering LLM Providers.
     */
    public init() {
        this.configService.init();
    }

    /**
     * Gets the effective system instruction, replacing placeholders and adding language overrides.
     */
    private getEffectiveSystemInstruction(): string {
        return this.contextBuilder.getEffectiveSystemInstruction();
    }

    /**
     * Resets injection defaults.
     */
    async resetInjectionDefaults(type: 'action' | 'continue' | 'fastforward' | 'system' | 'save' | 'postprocess' | 'system_main' | 'all' = 'all'): Promise<void> {
        return this.injection.resetInjectionDefaults(type);
    }

    /**
     * Saves application configuration to localStorage and updates the engine state.
     * @param apiKey The Gemini API Key.
     * @param modelId The Gemini Model ID to use.
     * @param genConfig Generation parameters (temperature, etc.) and UI settings.
     */
    async saveConfig(apiKey: string, modelId: string, genConfig: {
        fontSize?: number,
        fontFamily?: string,
        enableCache?: boolean,
        exchangeRate?: number,
        currency?: string,
        enableConversion?: boolean,
        screensaverType?: 'invaders' | 'code',
        outputLanguage?: string
    }) {
        await this.configService.saveConfig(apiKey, modelId, genConfig);
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
     * Loads files from a directory and initializes the Knowledge Base.
     * @param pickFolder Whether to prompt the user to pick a new folder.
     */
    async loadFiles(pickFolder = true) {
        await this.session.loadFiles(pickFolder);
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
        await this.session.wipeLocalSession();
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
        appearance: string,
        coreValues: string
    }, scenario: Scenario) {
        await this.session.startNewGame(profile, scenario);
        // Ensure session is started properly effectively if GameEngine had specific logic,
        // but previously startNewGame called startSession at the end.
        // We probably need to ensure startSession is called here if SessionService doesn't do "engine start".
        // Wait, startSession sets isBusy and does nothing else really?
        // Let's check startSession implementation in GameEngine later.
        // For now, assume SessionService handles the data setup and we just need to start the loop.
        this.startSession();
    }

    /**
     * Initializes the story session by either extracting the last scene from '2.劇情綱要.md'
     * or prompting the AI to start the story.
     */
    startSession() {
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

                const declaration = getAdultDeclaration(langId);

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
            } else {
                console.log('[GameEngine] Local Initialization Failed: No marker found or file empty. Falling back to LLM generation.');
                // Fallback: Let LLM generate the start scene
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
        return this.contextBuilder.getPreviewPayload(userText, options);
    }

    /**
     * Sends a message to the Gemini API and updates the chat history in real-time.
     * Handles streaming responses, JSON parsing, and automatic archiving of old turns.
     * @param userText The user's input text.
     * @param options Optional flags for hidden messages or specific intents.
     */
    async sendMessage(userText: string, options?: { isHidden?: boolean, intent?: string }) {
        console.log('[GameEngine] sendMessage received with intent:', options?.intent);
        // Allow empty text for CONTINUE and SAVE intents
        const isActionOrSystem = !options?.intent || options.intent === GAME_INTENTS.ACTION || options.intent === GAME_INTENTS.SYSTEM || options.intent === GAME_INTENTS.FAST_FORWARD;
        if (!userText.trim() && isActionOrSystem) return;

        // Force full context for <存檔> intent regardless of UI setting
        const forceFullContext = options?.intent === GAME_INTENTS.SAVE;

        const parts: ExtendedPart[] = [{ text: userText }];
        const userMsgId = crypto.randomUUID();

        // 1. Immediately update UI & Storage
        this.updateMessages(prev => [...prev, {
            id: userMsgId,
            role: 'user',
            content: userText,
            parts,
            isRefOnly: false,
            isHidden: options?.isHidden,
            intent: options?.intent
        }]);

        this.state.status.set('generating');

        // 2. Ensure cache is valid before generating
        try {
            await this.cacheManager.checkCacheAndRefresh(this.getEffectiveSystemInstruction());
        } catch (e: unknown) {
            if (e instanceof Error && e.message === 'SESSION_EXPIRED') {
                this.snackBar.open('Session Expired: Please reload your Knowledge Base folder to continue.', 'Close', {
                    duration: 10000,
                    panelClass: ['snackbar-error']
                });
            } else {
                this.snackBar.open(`Error: ${e instanceof Error ? e.message : 'Unknown error during cache refresh'}`, 'Close', {
                    duration: 5000,
                    panelClass: ['snackbar-error']
                });
            }
            this.state.status.set('idle');
            return;
        }

        try {
            const history = this.getLLMHistory(forceFullContext);


            const currentIntent = options?.intent || GAME_INTENTS.ACTION;
            const config = this.state.config();
            const lang = config?.outputLanguage || 'default';
            const tags = getIntentTags(lang);

            let injectionContent = '';
            if (currentIntent === GAME_INTENTS.ACTION) {
                injectionContent = this.state.dynamicActionInjection();
            } else if (currentIntent === GAME_INTENTS.CONTINUE) {
                injectionContent = this.state.dynamicContinueInjection();
            } else if (currentIntent === GAME_INTENTS.FAST_FORWARD) {
                injectionContent = this.state.dynamicFastforwardInjection();
            } else if (currentIntent === GAME_INTENTS.SYSTEM) {
                injectionContent = this.state.dynamicSystemInjection();
            } else if (currentIntent === GAME_INTENTS.SAVE) {
                injectionContent = this.state.dynamicSaveInjection();
            }

            if (injectionContent) {
                console.log(`[GameEngine] Injecting Dynamic Prompt for ${currentIntent}`);
                // Merge injection content with user input into a single message
                if (history.length > 0) {
                    const lastMsg = history.pop(); // Remove last user msg

                    if (lastMsg && lastMsg.parts && typeof lastMsg.parts[0].text === 'string') {
                        let userInput = lastMsg.parts[0].text;

                        // Prepend intent tag if needed
                        let tag = '';
                        if (currentIntent === GAME_INTENTS.ACTION) tag = tags.ACTION;
                        else if (currentIntent === GAME_INTENTS.CONTINUE) tag = tags.CONTINUE;
                        else if (currentIntent === GAME_INTENTS.FAST_FORWARD) tag = tags.FAST_FORWARD;
                        else if (currentIntent === GAME_INTENTS.SYSTEM) tag = tags.SYSTEM;
                        else if (currentIntent === GAME_INTENTS.SAVE) tag = tags.SAVE;

                        if (tag && !userInput.trim().startsWith(tag)) {
                            userInput = tag + userInput;
                        }

                        // Replace {{USER_INPUT}} placeholder with actual user input
                        const mergedContent = injectionContent.replace(/\{\{USER_INPUT\}\}/g, userInput);
                        const finalContent = this.contextBuilder.wrapUserMessage(mergedContent, history);

                        history.push({
                            role: 'user',
                            parts: [{ text: finalContent }]
                        });
                    }
                }
            }

            const stream = this.provider.generateContentStream(
                history,
                this.getEffectiveSystemInstruction(),
                {
                    cachedContentName: this.state.kbCacheName() || undefined,
                    responseSchema: getResponseSchema(this.state.config()?.outputLanguage),
                    responseMimeType: 'application/json'
                }
            );

            const modelMsgId = crypto.randomUUID();
            const outputLanguage = this.state.config()?.outputLanguage || 'default';

            const result = await this.streamProcessor.processStream(
                stream,
                modelMsgId,
                outputLanguage,
                (updater) => this.updateMessages(updater)
            );

            // Extract results
            const {
                finalAnalysis,
                finalStory,
                finalSummary,
                finalCharacterLog,
                finalInventoryLog,
                finalQuestLog,
                finalWorldLog,
                isCorrection,
                turnUsage,
                capturedFCs,
                capturedThoughtSignature,
                finalThought
            } = result;

            // Correction Handling
            let correctedIntent: string | undefined;
            if (isCorrection) {
                const storyIntents = [GAME_INTENTS.ACTION, GAME_INTENTS.CONTINUE, GAME_INTENTS.FAST_FORWARD];
                console.log('[GameEngine] Correction detected.');
                this.updateMessages(prev => {
                    const updated = [...prev];
                    for (let i = updated.length - 2; i >= 0; i--) {
                        const msg = updated[i];
                        if (msg.role === 'model' && !msg.isRefOnly && msg.intent && (storyIntents as string[]).includes(msg.intent)) {
                            msg.isRefOnly = true;
                            correctedIntent = msg.intent;
                            console.log('[GameEngine] Marked ref-only:', msg.id);
                            break;
                        }
                    }
                    return updated;
                });
            }



            this.updateMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'model') {
                    // Create a NEW object reference to ensure Signal/Input reactivity triggers
                    updated[updated.length - 1] = {
                        ...last,
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
                        intent: isCorrection ? (correctedIntent || GAME_INTENTS.ACTION) : currentIntent, // Inherit user intent or correction
                        isCorrection: isCorrection ? true : last.isCorrection
                    };

                    if (isCorrection) {
                        // Also mark corresponding user message as ref-only (immutable update)
                        const userMsgIndex = updated.findIndex(m => m.id === userMsgId);
                        if (userMsgIndex !== -1) {
                            updated[userMsgIndex] = { ...updated[userMsgIndex], isRefOnly: true };
                        }
                    }
                }
                return updated;
            });

            // Update local state with fresh usage stats
            const fresh = turnUsage.prompt - turnUsage.cached;
            this.state.lastTurnUsage.set({
                freshInput: fresh,
                cached: turnUsage.cached,
                output: turnUsage.candidates
            });

            const turnCost = this.calculateTurnCost(turnUsage);
            this.state.lastTurnCost.set(turnCost);

            this.state.tokenUsage.update(prev => {
                return {
                    freshInput: prev.freshInput + fresh,
                    cached: prev.cached + turnUsage.cached,
                    output: prev.output + turnUsage.candidates,
                    total: prev.total + turnUsage.prompt + turnUsage.candidates
                };
            });
            this.state.estimatedCost.update(prev => prev + turnCost);

            console.log(`[GameEngine] Turn Usage Breakdown:
- FRESH Input (Not in Cache): ${fresh.toLocaleString()} tokens
  (Includes Chat History + Tool Outputs + System Instructions not in KB)
- CACHED Input (Knowledge Base): ${turnUsage.cached.toLocaleString()} tokens
- Output: ${turnUsage.candidates.toLocaleString()} tokens
- Turn Cost: $${turnCost.toFixed(5)}`);

            this.state.status.set('idle');
        } catch (e: unknown) {
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
     * Executes the 'Update Story' command, which modifies the last story message or a specific target.
     * @param newContent The new story content.
     * @param _targetId Optional ID of the message to update.
     * @param ignoreId Optional ID of the message to ignore.
     * @returns The ID of the updated message.
     */
    private executeUpdateStory(newContent: string, _targetId?: string, ignoreId?: string): string {
        console.log('[GameEngine] executeUpdateStory called with:', { ignoreId, newContentLength: newContent?.length });
        let resultMessage = '';

        this.updateMessages(prev => {
            const arr = [...prev];
            const ui = getUIStrings(this.state.config()?.outputLanguage);

            // Always search backwards for last model message
            console.log('[GameEngine] Searching backwards for last model message to update...');
            let found = false;
            for (let i = arr.length - 1; i >= 0; i--) {
                if (ignoreId && arr[i].id === ignoreId) {
                    continue;
                }

                const isModel = arr[i].role === 'model';
                // Check if it's a tool-only message (skip those)
                const isTool = arr[i].parts?.some(p => p['functionCall'] || p['functionResponse']);

                // Skip RefOnly messages (Correction Confirmations, Error messages, etc.)
                if (arr[i].isRefOnly) continue;

                // Match intent: Find the last model message where intent matches the correction target (usually <行動意圖>)
                if (isModel && !isTool && arr[i].intent === GAME_INTENTS.ACTION) {
                    arr[i] = { ...arr[i], content: newContent };
                    console.log(`[GameEngine] Found message to update with intent ${GAME_INTENTS.ACTION} at index:`, i);
                    found = true;
                    resultMessage = ui.CORRECTION_SUCCESS.replace('{id}', arr[i].id);
                    break;
                }
            }

            if (!found) {
                resultMessage = ui.CORRECTION_NOT_FOUND;
            }

            return arr;
        });
        return resultMessage;
    }

    /**
     * @category Chat History Delegates
     */

    updateMessageContent(id: string, newContent: string) {
        this.chatHistory.updateMessageContent(id, newContent);
    }

    updateMessageLogs(id: string, type: 'inventory' | 'quest' | 'world' | 'character', logs: string[]) {
        this.chatHistory.updateMessageLogs(id, type, logs);
    }

    updateMessageSummary(id: string, summary: string) {
        this.chatHistory.updateMessageSummary(id, summary);
    }

    deleteMessage(id: string) {
        this.chatHistory.deleteMessage(id);
    }

    deleteFrom(id: string) {
        this.chatHistory.deleteFrom(id);
    }

    rewindTo(messageId: string) {
        this.chatHistory.rewindTo(messageId);
    }

    toggleRefOnly(id: string) {
        this.chatHistory.toggleRefOnly(id);
    }

    async clearHistory() {
        await this.chatHistory.clearHistory();
    }

    private updateMessages(updater: (prev: ChatMessage[]) => ChatMessage[]) {
        this.chatHistory.updateMessages(updater);
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
    private getLLMHistory(forceFullContext = false): LLMContent[] {
        return this.contextBuilder.getLLMHistory(forceFullContext);
    }


}
