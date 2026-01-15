import { Injectable, signal, computed, effect, inject } from '@angular/core';
import { FileSystemService } from './file-system.service';

import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMProvider, LLMCacheInfo, LLMStreamChunk, LLMContent, LLMPart, LLMGenerateConfig } from './llm-provider';
import { StorageService } from './storage.service';
import { CostService } from './cost.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { EngineResponseNested, ThoughtPart, ChatMessage, SessionSave, ExtendedPart } from '../models/types';
import { parse as parseJson } from 'best-effort-json-parser';

import { GAME_INTENTS } from '../constants/game-intents';
import { getResponseSchema, getAdultDeclaration, INJECTION_FILE_PATHS, getCoreFilenames, getSectionHeaders, LLM_MARKERS } from '../constants/engine-protocol';
import { getLocale, LOCALES } from '../constants/locales';

interface GameEngineConfig {
    apiKey?: string;
    modelId?: string;
    fontSize?: number;
    fontFamily?: string;
    enableCache?: boolean;
    exchangeRate?: number;
    currency?: string;
    enableConversion?: boolean;
    screensaverType?: 'invaders' | 'code';
    outputLanguage?: string;
}

@Injectable({
    providedIn: 'root'
})
export class GameEngineService {
    private fileSystem = inject(FileSystemService);

    private providerRegistry = inject(LLMProviderRegistryService);
    private storage = inject(StorageService);
    private cost = inject(CostService);
    private snackBar = inject(MatSnackBar);

    /** Get the currently active LLM provider */
    private get provider(): LLMProvider {
        const p = this.providerRegistry.getActive();
        if (!p) throw new Error('No active LLM provider');
        return p;
    }

    config = signal<GameEngineConfig | null>(null);
    isConfigured = computed(() => !!this.config()?.apiKey);

    messages = signal<ChatMessage[]>([]);
    status = signal<'idle' | 'loading' | 'generating' | 'error'>('idle');
    isBusy = computed(() => this.status() === 'loading' || this.status() === 'generating');
    loadedFiles = signal<Map<string, string>>(new Map());
    kbFileUri = signal<string | null>(null);
    kbCacheName = signal<string | null>(null);
    kbCacheExpireTime = signal<number | null>(null);
    cacheCountdown = this.cost.cacheCountdown;
    storageCostAccumulated = this.cost.storageCostAccumulated;
    historyStorageCostAccumulated = signal<number>(0);
    lastTurnUsage = signal<{ freshInput: number, cached: number, output: number } | null>(null);
    lastTurnCost = signal<number>(0);
    tokenUsage = signal<{ freshInput: number, cached: number, output: number, total: number }>({ freshInput: 0, cached: 0, output: 0, total: 0 });
    estimatedKbTokens = signal<number>(0);

    fileTokenCounts = signal<Map<string, number>>(new Map());

    // KB Hash for Verification
    currentKbHash = signal<string>('');

    estimatedCost = signal<number>(0);

    /**
     * Calculates the estimated cost of a single turn based on token usage.
     * @param turnUsage Object containing prompt, candidates, and cached tokens.
     * @returns The calculated cost in USD.
     */
    private calculateTurnCost(turnUsage: { prompt: number, candidates: number, cached: number }) {
        return this.cost.calculateTurnCost(turnUsage, this.config()?.modelId);
    }

    private startStorageTimer() {
        this.cost.updateContextState(
            this.kbCacheTokens,
            this.kbCacheExpireTime(),
            this.config()?.modelId || this.provider.getDefaultModelId(),
            this.kbCacheName()
        );
        this.cost.startStorageTimer();
    }

    private stopStorageTimer() {
        this.cost.stopStorageTimer();
    }

    private kbCacheTokens = 0;
    private systemInstructionCache = '';
    private isContextInjected = false;

    // Dynamic Injection: Append reminder to each request to reinforce thinking
    enableDynamicInjection = signal<boolean>(true);

    // Version for tracking default injection text changes (increment when defaults are updated)
    // Now uses content hash for automatic detection
    private injectionContentHash = '';

    // Flag to prevent effects from saving until after initial load
    private injectionSettingsLoaded = signal(false);

    // Injection file paths (loaded from assets)
    private readonly INJECTION_FILE_PATHS = INJECTION_FILE_PATHS;

    // Editable injection text signals (loaded from files on init)
    dynamicActionInjection = signal<string>('');
    dynamicContinueInjection = signal<string>('');
    dynamicFastforwardInjection = signal<string>('');
    dynamicSystemInjection = signal<string>('');
    dynamicSaveInjection = signal<string>('');

    // Context Mode: 'smart' (Summary + Last 10) | 'full' (Everything)
    contextMode = signal<'smart' | 'full'>('smart');

    /**
     * Normalizes line endings to LF (\n) for consistent hashing across platforms.
     * @param str The input string.
     * @returns The normalized string.
     */
    private normalizeLineEndings(str: string): string {
        return str.replace(/\r\n/g, '\n');
    }

    /**
     * Normalizes KB text and calculates a hash for cache reuse verification.
     * @param kbText The raw text of the knowledge base.
     * @returns A string hash.
     */
    private calculateKbHash(kbText: string): string {
        const rawInput = this.normalizeLineEndings(kbText) + (this.config()?.modelId || '') + (this.systemInstructionCache || '');
        return this.hashString(rawInput.trim());
    }

    /**
     * Generates a 32-bit integer string hash for a given string.
     * @param str The input string.
     * @returns The generated hash string.
     */
    private hashString(str: string): string {
        let hash = 0;
        if (str.length === 0) return hash.toString();
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32bit integer
        }
        return hash.toString();
    }

    constructor() {
        this.loadHistoryFromStorage();
        this.loadDynamicInjectionSettings();

        effect(() => {
            const cfg = this.config();
            if (cfg) {
                if (cfg.fontSize) {
                    document.body.style.setProperty('--app-font-size', `${cfg.fontSize}px`);
                }
                if (cfg.fontFamily) {
                    document.body.style.setProperty('--app-font-family', cfg.fontFamily);
                }
            }
        });

        // Auto-save Usage Stats
        effect(() => {
            const usage = this.tokenUsage();
            localStorage.setItem('usage_stats', JSON.stringify(usage));
        });
        effect(() => {
            const cost = this.estimatedCost();
            localStorage.setItem('estimated_cost', cost.toString());
        });
        effect(() => {
            const acc = this.storageCostAccumulated();
            localStorage.setItem('storage_cost_acc', acc.toString());
        });
        effect(() => {
            const hAcc = this.historyStorageCostAccumulated();
            localStorage.setItem('history_storage_cost_acc', hAcc.toString());
        });

        // Auto-save Dynamic Injection Settings (only after initial load)
        effect(() => {
            const enabled = this.enableDynamicInjection();
            if (this.injectionSettingsLoaded()) {
                localStorage.setItem('enable_dynamic_injection', enabled.toString());
            }
        });
        effect(() => {
            const text = this.dynamicActionInjection();
            if (this.injectionSettingsLoaded()) {
                localStorage.setItem('dynamic_action_injection', text);
            }
        });
        effect(() => {
            const text = this.dynamicContinueInjection();
            if (this.injectionSettingsLoaded()) {
                localStorage.setItem('dynamic_continue_injection', text);
            }
        });
        effect(() => {
            const text = this.dynamicFastforwardInjection();
            if (this.injectionSettingsLoaded()) {
                localStorage.setItem('dynamic_fastforward_injection', text);
            }
        });
        effect(() => {
            const text = this.dynamicSystemInjection();
            if (this.injectionSettingsLoaded()) {
                localStorage.setItem('dynamic_system_injection', text);
            }
        });
        effect(() => {
            const text = this.dynamicSaveInjection();
            if (this.injectionSettingsLoaded()) {
                localStorage.setItem('dynamic_save_injection', text);
            }
        });
    }

    /**
     * Loads a single injection file from assets.
     * @param path Path to the file.
     * @returns The file content.
     */
    private async loadInjectionFile(path: string): Promise<string> {
        try {
            const response = await fetch(path, { cache: 'no-store' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const text = await response.text();
            return text.trim();
        } catch (err) {
            console.error(`[GameEngine] Failed to load injection file: ${path}`, err);
            return '';
        }
    }

    private isSettingsLoading = false;

    /**
     * Loads dynamic injection settings from localStorage or MD files.
     * Uses content hash for automatic detection of file changes.
     */
    private async loadDynamicInjectionSettings() {
        if (this.isSettingsLoading) return;
        this.isSettingsLoading = true;

        try {
            const savedEnabled = localStorage.getItem('enable_dynamic_injection');
            if (savedEnabled !== null) {
                this.enableDynamicInjection.set(savedEnabled === 'true');
            }

            // Load all 5 injection files
            const [actionContent, continueContent, fastforwardContent, systemContent, saveContent] = await Promise.all([
                this.loadInjectionFile(this.INJECTION_FILE_PATHS.action),
                this.loadInjectionFile(this.INJECTION_FILE_PATHS.continue),
                this.loadInjectionFile(this.INJECTION_FILE_PATHS.fastforward),
                this.loadInjectionFile(this.INJECTION_FILE_PATHS.system),
                this.loadInjectionFile(this.INJECTION_FILE_PATHS.save)
            ]);

            // Compute content hash from all files after normalizing line endings
            const combinedContent = actionContent + continueContent + fastforwardContent + systemContent + saveContent;
            const currentHash = this.hashString(this.normalizeLineEndings(combinedContent));
            this.injectionContentHash = currentHash;

            // Hash check: if stored hash differs, use new file contents
            const savedHash = localStorage.getItem('injection_content_hash');

            if (savedHash !== currentHash) {
                // First time or content changed - use MD file contents
                console.log('[GameEngine] Injection files changed, loading new content. Hash:', currentHash);

                const lang = localStorage.getItem('gemini_output_language') || 'default';

                // Update signals FIRST with localized content
                this.dynamicActionInjection.set(this.applyPromptPlaceholders(actionContent, lang));
                this.dynamicContinueInjection.set(this.applyPromptPlaceholders(continueContent, lang));
                this.dynamicFastforwardInjection.set(this.applyPromptPlaceholders(fastforwardContent, lang));
                this.dynamicSystemInjection.set(this.applyPromptPlaceholders(systemContent, lang));
                this.dynamicSaveInjection.set(this.applyPromptPlaceholders(saveContent, lang));

                // Set flag to true so effects will save the NEW values to LS
                this.injectionSettingsLoaded.set(true);

                // Save new hash to LS LAST to prevent race conditions on reload
                localStorage.setItem('injection_content_hash', currentHash);
                return;
            }

            // Same hash - load saved customizations from localStorage
            const savedAction = localStorage.getItem('dynamic_action_injection');
            if (savedAction !== null) this.dynamicActionInjection.set(savedAction);

            const savedContinue = localStorage.getItem('dynamic_continue_injection');
            if (savedContinue !== null) this.dynamicContinueInjection.set(savedContinue);

            const savedFastforward = localStorage.getItem('dynamic_fastforward_injection');
            if (savedFastforward !== null) this.dynamicFastforwardInjection.set(savedFastforward);

            const savedSystem = localStorage.getItem('dynamic_system_injection');
            if (savedSystem !== null) this.dynamicSystemInjection.set(savedSystem);

            const savedSave = localStorage.getItem('dynamic_save_injection');
            if (savedSave !== null) this.dynamicSaveInjection.set(savedSave);

            this.injectionSettingsLoaded.set(true);
        } finally {
            this.isSettingsLoading = false;
        }
    }

    /**
     * Resets injection prompts to defaults from MD files.
     * @param type Which injection to reset, or 'all' for all five.
     */
    async resetInjectionDefaults(type: 'action' | 'continue' | 'fastforward' | 'system' | 'save' | 'all' = 'all'): Promise<void> {
        const loadAction = type === 'action' || type === 'all';
        const loadContinue = type === 'continue' || type === 'all';
        const loadFastforward = type === 'fastforward' || type === 'all';
        const loadSystem = type === 'system' || type === 'all';
        const loadSave = type === 'save' || type === 'all';

        const promises: Promise<string>[] = [];
        if (loadAction) promises.push(this.loadInjectionFile(this.INJECTION_FILE_PATHS.action));
        if (loadContinue) promises.push(this.loadInjectionFile(this.INJECTION_FILE_PATHS.continue));
        if (loadFastforward) promises.push(this.loadInjectionFile(this.INJECTION_FILE_PATHS.fastforward));
        if (loadSystem) promises.push(this.loadInjectionFile(this.INJECTION_FILE_PATHS.system));
        if (loadSave) promises.push(this.loadInjectionFile(this.INJECTION_FILE_PATHS.save));

        const results = await Promise.all(promises);
        let idx = 0;

        const lang = this.config()?.outputLanguage || localStorage.getItem('gemini_output_language') || 'default';
        if (loadAction) this.dynamicActionInjection.set(this.applyPromptPlaceholders(results[idx++], lang));
        if (loadContinue) this.dynamicContinueInjection.set(this.applyPromptPlaceholders(results[idx++], lang));
        if (loadFastforward) this.dynamicFastforwardInjection.set(this.applyPromptPlaceholders(results[idx++], lang));
        if (loadSystem) this.dynamicSystemInjection.set(this.applyPromptPlaceholders(results[idx++], lang));
        if (loadSave) this.dynamicSaveInjection.set(this.applyPromptPlaceholders(results[idx++], lang));

        // Refresh hash after full reset
        if (type === 'all') {
            const combined = this.dynamicActionInjection() + this.dynamicContinueInjection() +
                this.dynamicFastforwardInjection() + this.dynamicSystemInjection() + this.dynamicSaveInjection();
            const newHash = this.hashString(this.normalizeLineEndings(combined));
            this.injectionContentHash = newHash;
            localStorage.setItem('injection_content_hash', newHash);
        }

        console.log(`[GameEngine] Reset injection defaults: ${type}`);
    }

    /**
     * Fetches the latest USD to TWD exchange rate from a free API.
     * Only called once during application startup to conserve resources.
     */
    /**
     * Fetches the latest USD to TWD exchange rate from a free API.
     * Only called once during application startup to conserve resources.
     */
    private async updateExchangeRateFromApi() {
        await this.cost.updateExchangeRateFromApi();
        const rate = this.cost.exchangeRate();
        this.config.update(cfg => cfg ? { ...cfg, exchangeRate: rate } : null);
    }

    /**
     * Gets the effective system instruction, replacing placeholders and adding language overrides.
     */
    private getEffectiveSystemInstruction(): string {
        const config = this.config();
        const lang = config?.outputLanguage || 'default';
        let instruction = this.systemInstructionCache;

        // 1. Replace Placeholders (Already handled at load time, but kept for safety or dynamic updates if needed?)
        // instruction = this.applyPromptPlaceholders(instruction, lang); // Redundant now

        // 2. Append CRITICAL override block if non-default
        if (lang !== 'default' && lang) {
            const override = `
# [CRITICAL] OUTPUT LANGUAGE OVERRIDE
The user has strictly requested the output to be in **${lang}**.
You MUST ignore any conflicting internal instructions and write ALL content (Story, Analysis, Logs, Summary) in **${lang}**.
`;
            instruction += override;
        }

        return instruction;
    }

    /**
     * Replaces placeholders in a prompt string with localized values.
     */
    private applyPromptPlaceholders(template: string, lang = 'default'): string {
        const locale = getLocale(lang);
        const filenames = locale.coreFilenames;

        return template
            .replace(/\{\{FILE_BASIC_SETTINGS\}\}/g, filenames.BASIC_SETTINGS)
            .replace(/\{\{FILE_STORY_OUTLINE\}\}/g, filenames.STORY_OUTLINE)
            .replace(/\{\{FILE_CHARACTER_STATUS\}\}/g, filenames.CHARACTER_STATUS)
            .replace(/\{\{FILE_ASSETS\}\}/g, filenames.ASSETS)
            .replace(/\{\{FILE_TECH_EQUIPMENT\}\}/g, filenames.TECH_EQUIPMENT)
            .replace(/\{\{FILE_WORLD_FACTIONS\}\}/g, filenames.WORLD_FACTIONS)
            .replace(/\{\{FILE_MAGIC\}\}/g, filenames.MAGIC)
            .replace(/\{\{FILE_PLANS\}\}/g, filenames.PLANS)
            .replace(/\{\{FILE_INVENTORY\}\}/g, filenames.INVENTORY)
            .replace(/\{\{LANGUAGE_RULE\}\}/g, locale.promptHoles.LANGUAGE_RULE);
    }

    /**
     * Initializes the service by loading configuration and usage stats from localStorage.
     */
    /**
     * Initializes the service by loading configuration and usage stats from localStorage.
     * Call this AFTER registering LLM Providers.
     */
    public init() {
        // Trigger FX rate update (don't await to avoid blocking init)
        this.updateExchangeRateFromApi();

        const key = localStorage.getItem('gemini_api_key');
        const model = localStorage.getItem('gemini_model_id') || this.provider.getDefaultModelId();

        const sSize = localStorage.getItem('app_font_size');
        const sFamily = localStorage.getItem('app_font_family');

        const fontSize = sSize ? parseInt(sSize, 10) : undefined;
        const fontFamily = sFamily || undefined;
        const enableCache = localStorage.getItem('gemini_enable_cache') === 'true';
        const sRate = localStorage.getItem('gemini_exchange_rate');
        const exchangeRate = sRate ? parseFloat(sRate) : 30;
        const screensaverType = (localStorage.getItem('app_screensaver_type') as 'invaders' | 'code') || 'invaders';
        const currency = localStorage.getItem('app_currency') || 'TWD';
        const enableConversion = localStorage.getItem('app_enable_conversion') === 'true';
        const outputLanguage = localStorage.getItem('gemini_output_language') || 'default';

        if (key) {
            const cfg: GameEngineConfig = {
                apiKey: key,
                modelId: model,
                fontSize,
                fontFamily,
                enableCache,
                exchangeRate,
                currency,
                enableConversion,
                screensaverType,
                outputLanguage
            };
            this.config.set(cfg);
            // Redundant: handled by LLMProviderInitService
            // this.providerRegistry.setActive(DEFAULT_PROVIDER_ID);
            this.provider.init({
                apiKey: key,
                modelId: model
            });

            // Restore cache/file state
            const cacheName = localStorage.getItem('kb_cache_name');
            const savedHash = localStorage.getItem('kb_cache_hash');
            const savedFileUri = localStorage.getItem('kb_file_uri');
            console.log('[DEBUG] initConfig Read:', { name: cacheName, hash: savedHash, fileUri: savedFileUri });

            if (savedFileUri) {
                this.kbFileUri.set(savedFileUri);
                console.log('[GameEngine] Restored KB File URI:', savedFileUri);
            }

            if (cacheName) {
                this.kbCacheName.set(cacheName);
                const savedTokens = localStorage.getItem('kb_cache_tokens');
                this.kbCacheTokens = savedTokens ? parseInt(savedTokens, 10) : 0;

                // Fetch expiration from API immediately to restore timer
                if (this.provider.getCache) {
                    this.provider.getCache(cacheName).then(cacheStatus => {
                        if (cacheStatus && cacheStatus.expireTime) {
                            const expireMs = typeof cacheStatus.expireTime === 'number'
                                ? cacheStatus.expireTime
                                : new Date(cacheStatus.expireTime).getTime();
                            this.kbCacheExpireTime.set(expireMs);
                            console.log('[GameEngine] Restored cache state from API:', cacheName, 'Expires at:', new Date(expireMs).toLocaleString());
                            this.startStorageTimer();
                        } else {
                            console.warn('[GameEngine] Saved cache not found on server or expired:', cacheName);
                            this.kbCacheName.set(null);
                            localStorage.removeItem('kb_cache_name');
                            localStorage.removeItem('kb_cache_hash');
                        }
                    });
                }
            }

            // Restore Usage Stats
            const savedUsage = localStorage.getItem('usage_stats'); // Define savedUsage here
            if (savedUsage) {
                try {
                    this.tokenUsage.set(JSON.parse(savedUsage));
                } catch (err) {
                    console.warn('Failed to parse saved usage stats', err);
                }
            }
            const savedCost = localStorage.getItem('estimated_cost');
            if (savedCost) {
                this.estimatedCost.set(parseFloat(savedCost));
            }
            const savedStorageCost = localStorage.getItem('storage_cost_acc');
            if (savedStorageCost) {
                this.storageCostAccumulated.set(parseFloat(savedStorageCost));
            }
            const savedHistoryStorageCost = localStorage.getItem('history_storage_cost_acc');
            if (savedHistoryStorageCost) {
                this.historyStorageCostAccumulated.set(parseFloat(savedHistoryStorageCost));
            }
            // Sync files from DB on startup
            this.loadFiles(false);
        }
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
        localStorage.setItem('gemini_api_key', apiKey);
        localStorage.setItem('gemini_model_id', modelId);

        if (genConfig.screensaverType !== undefined) localStorage.setItem('app_screensaver_type', genConfig.screensaverType);

        if (genConfig.currency !== undefined) localStorage.setItem('app_currency', genConfig.currency);
        if (genConfig.enableConversion !== undefined) localStorage.setItem('app_enable_conversion', genConfig.enableConversion.toString());
        if (genConfig.outputLanguage !== undefined) localStorage.setItem('gemini_output_language', genConfig.outputLanguage);

        if (genConfig.exchangeRate !== undefined) localStorage.setItem('gemini_exchange_rate', genConfig.exchangeRate.toString());

        if (genConfig.fontSize !== undefined) localStorage.setItem('app_font_size', genConfig.fontSize.toString());
        else localStorage.removeItem('app_font_size');

        if (genConfig.fontFamily !== undefined) localStorage.setItem('app_font_family', genConfig.fontFamily);
        else localStorage.removeItem('app_font_family');

        if (genConfig.enableCache !== undefined) localStorage.setItem('gemini_enable_cache', genConfig.enableCache.toString());
        else localStorage.removeItem('gemini_enable_cache');

        const fullConfig = { apiKey, modelId, ...genConfig };
        this.config.set(fullConfig);

        // Redundant: handled by LLMProviderInitService
        // this.providerRegistry.setActive(DEFAULT_PROVIDER_ID);
        this.provider.init({
            apiKey,
            modelId,
            ...genConfig
        });

        // Persist to IndexedDB for other services (e.g. Google Drive) to access
        this.storage.set('settings', fullConfig);

        // If language changed, we need to re-process system files for the UI
        if (genConfig.outputLanguage) {
            this.loadFiles(false);
            this.loadDynamicInjectionSettings();
        }
    }



    /**
     * Imports configuration from a plain object (e.g. from JSON).
     * @param config The configuration object to restore.
     */
    importConfig(config: unknown) {
        if (!config || typeof config !== 'object') {
            console.error('[GameEngine] Invalid config object provided for import');
            return;
        }
        const cfg = config as GameEngineConfig;

        // Validate essential fields or just apply what we can
        const apiKey = cfg.apiKey || '';
        const modelId = cfg.modelId || this.provider.getDefaultModelId();

        // Construct the full config object, ensuring types match expected optional fields
        const genConfig = {
            fontSize: typeof cfg.fontSize === 'number' ? cfg.fontSize : undefined,
            fontFamily: typeof cfg.fontFamily === 'string' ? cfg.fontFamily : undefined,
            enableCache: typeof cfg.enableCache === 'boolean' ? cfg.enableCache : undefined,
            exchangeRate: typeof cfg.exchangeRate === 'number' ? cfg.exchangeRate : undefined,
            currency: typeof cfg.currency === 'string' ? cfg.currency : undefined,
            enableConversion: typeof cfg.enableConversion === 'boolean' ? cfg.enableConversion : undefined,
            screensaverType: (cfg.screensaverType === 'invaders' || cfg.screensaverType === 'code') ? cfg.screensaverType : undefined,
            outputLanguage: typeof cfg.outputLanguage === 'string' ? cfg.outputLanguage : undefined
        };

        // Reuse saveConfig to handle persistence (localStorage + Signal update + Service re-init)
        this.saveConfig(apiKey, modelId, genConfig);
        console.log('[GameEngine] Configuration imported successfully.');
    }

    /**
     * Loads chat history from local persistent storage.
     */
    private async loadHistoryFromStorage() {
        const saved = await this.storage.get('chat_history');
        if (saved && Array.isArray(saved)) {
            this.messages.set(saved);
            if (saved.length > 0) {
                this.isContextInjected = true;
            }
        }
    }

    /**
     * Exports the current session state for saving.
     * @returns A SessionSave object containing the current state.
     */
    exportSession(): SessionSave {
        const msgs = this.messages();
        const lastModelMsg = [...msgs].reverse().find(m => m.role === 'model' && m.content && !m.isRefOnly);
        const preview = lastModelMsg?.content?.substring(0, 200) || '';

        return {
            id: '',  // Will be set by the dialog
            name: '', // Will be set by the dialog
            timestamp: Date.now(),
            messages: msgs,
            tokenUsage: this.tokenUsage(),
            estimatedCost: this.estimatedCost(),
            storyPreview: preview,
            kbHash: this.currentKbHash()
        };
    }

    /**
     * Imports a saved session state.
     * @param save The SessionSave to restore.
     */
    async importSession(save: SessionSave) {
        // Restore messages
        this.messages.set(save.messages);
        await this.storage.set('chat_history', save.messages);

        // Restore usage stats
        this.tokenUsage.set(save.tokenUsage);
        this.estimatedCost.set(save.estimatedCost);

        if (save.messages.length > 0) {
            this.isContextInjected = true;
        }

        console.log('[GameEngine] Session imported:', save.name);
    }

    /**
     * Bulk imports files into the persistent store (IndexedDB) and reloads the engine state.
     * Use this when fetching files from Cloud or other non-local sources.
     */
    async importFiles(files: Map<string, string>) {
        this.status.set('loading');
        try {
            await this.storage.clearFiles();
            for (const [name, content] of files.entries()) {
                // Never save the system prompt to IndexedDB
                if (name !== 'system_files/system_prompt.md') {
                    await this.storage.saveFile(name, content);
                }
            }
            // Now trigger a standard reload (without picking a folder) to rebuild tokens/KB
            await this.loadFiles(false);
        } catch (err) {
            console.error('[GameEngine] Import failed', err);
            throw err;
        } finally {
            this.status.set('idle');
        }
    }

    /**
     * Updates a single file in storage and refreshes the loadedFiles signal.
     * Use this after applying auto-updates to ensure sync sees the changes.
     * @param filePath The file path/name.
     * @param content The new content.
     */
    async updateSingleFile(filePath: string, content: string): Promise<void> {
        // 1. Save to IndexedDB
        await this.storage.saveFile(filePath, content);

        // 2. Update loadedFiles signal in place
        this.loadedFiles.update(map => {
            const newMap = new Map(map);
            newMap.set(filePath, content);
            return newMap;
        });

        console.log('[GameEngine] Updated file:', filePath);
    }

    /**
     * Loads files from a directory and initializes the Knowledge Base.
     * @param pickFolder Whether to prompt the user to pick a new folder.
     */
    async loadFiles(pickFolder = true) {
        try {
            if (pickFolder) {
                await this.fileSystem.selectDirectory();
                await this.fileSystem.syncDiskToDb();
            }
            this.status.set('loading');
            const files = await this.fileSystem.loadInitialFiles();
            const contentMap = new Map<string, string>();
            const tokenMap = new Map<string, number>();

            const lang = this.config()?.outputLanguage || localStorage.getItem('gemini_output_language') || 'default';
            files.forEach((meta, name) => {
                let content = meta.content;
                // Apply placeholders for system files at load time for UI visibility
                if (name.startsWith('system_files/') || name === 'system_prompt.md') {
                    content = this.applyPromptPlaceholders(content, lang);
                }
                contentMap.set(name, content);
            });
            this.loadedFiles.set(contentMap);

            // 1. Set System Prompt
            const systemFile = contentMap.get('system_files/system_prompt.md');
            this.systemInstructionCache = systemFile || 'You are an interactive story engine.';

            // Calculate tokens (Use cache where possible)
            const modelId = this.config()?.modelId || this.provider.getDefaultModelId();
            const needsCount: { name: string, content: string }[] = [];

            files.forEach((meta, name) => {
                if (meta.tokens !== undefined) {
                    tokenMap.set(name, meta.tokens);
                } else {
                    needsCount.push({ name, content: meta.content });
                }
            });

            if (needsCount.length > 0) {
                console.log(`[GameEngine] Counting tokens for ${needsCount.length} new/updated files...`);
                await Promise.all(needsCount.map(async (item) => {
                    const count = await this.provider.countTokens(modelId, [{ role: 'user', parts: [{ text: item.content }] }]);
                    tokenMap.set(item.name, count);
                    // Update DB with the new count for next time, but skip system prompt
                    if (item.name !== 'system_files/system_prompt.md') {
                        await this.storage.saveFile(item.name, item.content, count);
                    }
                }));
            }

            this.fileTokenCounts.set(tokenMap);

            // 2. Build KB text
            let kbText = '';
            contentMap.forEach((content, path) => {
                // Exclude system prompt from context injection (KB text) as it's already in systemInstruction
                if (!path.startsWith('system_files/') && path !== 'system_prompt.md') {
                    kbText += `${LLM_MARKERS.FILE_CONTENT_SEPARATOR} [${path}] ---\\n${content}\\n\\n`;
                }
            });

            // Calculate total KB tokens (Use cache where possible)
            const currentHash = this.calculateKbHash(kbText);
            const savedHash = localStorage.getItem('kb_cache_hash');
            const cachedTotal = localStorage.getItem('kb_cache_tokens');

            let totalTokenCount = 0;
            if (savedHash === currentHash && cachedTotal) {
                totalTokenCount = parseInt(cachedTotal);
                console.log('[GameEngine] Reusing cached total KB tokens:', totalTokenCount);
            } else {
                const partsForCount = this.buildKnowledgeBaseParts(contentMap);

                totalTokenCount = await this.provider.countTokens(modelId, [{ role: 'user', parts: partsForCount }]);
                localStorage.setItem('kb_cache_tokens', totalTokenCount.toString());
                console.log('[GameEngine] Counted new total KB tokens:', totalTokenCount);
            }
            this.estimatedKbTokens.set(totalTokenCount);
            console.log('[GameEngine] Estimated KB Tokens:', totalTokenCount);

            // Set current KB hash for verification
            this.currentKbHash.set(currentHash);

            // Defer remote cleanup and upload to sendMessage -> checkCacheAndRefresh
            if (kbText.trim()) {
                if (savedHash !== currentHash) {
                    console.log('[GameEngine] KB Content changed. Invalidating remote state, will refresh on next message.');
                    this.kbFileUri.set(null);
                    this.kbCacheName.set(null);
                    localStorage.removeItem('kb_file_uri');
                    localStorage.removeItem('kb_cache_name');
                    localStorage.setItem('kb_cache_hash', currentHash); // Update hash locally immediately
                } else {
                    console.log('[GameEngine] KB Content unchanged. Remote state likely still valid.');
                }
            } else {
                this.kbFileUri.set(null);
                localStorage.removeItem('kb_file_uri');
            }

            // Allow a fresh injection if user loaded a folder
            this.isContextInjected = false;
            this.status.set('idle');
        } catch (e) {
            console.error(e);
            this.status.set('error');
        }
    }

    /**
     * Cleans up the active context cache on the server and resets local cache-related signals.
     */
    async cleanupCache() {
        if (this.kbCacheName()) {
            console.log('Cleaning up cache:', this.kbCacheName());

            // Before clearing, add the current session's storage cost to history
            const currentAcc = this.storageCostAccumulated();
            if (currentAcc > 0) {
                this.historyStorageCostAccumulated.update(v => v + currentAcc);
                this.storageCostAccumulated.set(0);
            }

            if (this.provider.deleteCache) {
                await this.provider.deleteCache(this.kbCacheName()!);
            }
            this.kbCacheName.set(null);
            this.kbCacheExpireTime.set(null);
            localStorage.removeItem('kb_cache_name');
            localStorage.removeItem('kb_cache_hash');
            localStorage.removeItem('kb_cache_expire');
            localStorage.removeItem('kb_cache_tokens'); // Also remove tokens
            localStorage.removeItem('kb_file_uri'); // Clear file URI as well
            this.stopStorageTimer();
            this.kbCacheTokens = 0;
        }
    }

    /**
     * Validates if the current Knowledge Base (Cache or File) is still available on the server.
     * If not, attempts to restore it from local files (Self-healing).
     * @throws Error with 'SESSION_EXPIRED' if context is lost and cannot be recovered.
     */
    private async checkCacheAndRefresh() {
        const config = this.config();
        const useCache = !!config?.enableCache;
        const cacheName = this.kbCacheName();
        let fileUri = this.kbFileUri();
        const hasLocalFiles = this.loadedFiles().size > 0;
        const ttlSeconds = 1800; // 30 minutes

        let validationSuccess = false;

        // 1. Validate based on CURRENT MODE (Cache or File)
        if (useCache) {
            if (cacheName && this.provider.getCache) {
                console.log('[GameEngine] Validating remote cache:', cacheName);
                const cacheStatus = await this.provider.getCache(cacheName);
                if (cacheStatus) {
                    try {
                        let updated: LLMCacheInfo | null = null;
                        if (this.provider.updateCacheTTL) {
                            updated = await this.provider.updateCacheTTL(cacheName, ttlSeconds);
                        }

                        // If updated valid, or just exists (fall through)
                        if (updated?.expireTime) {
                            const expireMs = typeof updated.expireTime === 'number'
                                ? updated.expireTime
                                : new Date(updated.expireTime).getTime();
                            this.kbCacheExpireTime.set(expireMs);
                            validationSuccess = true;
                            this.startStorageTimer();
                            console.log('[GameEngine] Cache validated and TTL extended.');
                        } else {
                            // If update failed but cache exists, we assume success but maybe no TTL extension
                            validationSuccess = true;
                            console.log('[GameEngine] Cache exists (TTL update skipped/failed).');
                        }
                    } catch (err) {
                        console.warn('[GameEngine] Cache TTL update failed, but cache exists.', err);
                        validationSuccess = true; // Still exists, so we can use it
                    }
                } else {
                    // Proactive cleanup
                    this.kbCacheName.set(null);
                    localStorage.removeItem('kb_cache_name');
                }
            }
        } else {
            if (fileUri) {
                console.log('[GameEngine] Validating remote file:', fileUri);
                let isAvailable = false;
                if (this.provider.isFileAvailable) {
                    isAvailable = await this.provider.isFileAvailable(fileUri);
                }
                if (isAvailable) {
                    validationSuccess = true;
                    console.log('[GameEngine] Remote file validated.');
                } else {
                    // Proactive cleanup
                    this.kbFileUri.set(null);
                    localStorage.removeItem('kb_file_uri');
                }
            }
        }

        // 2. If validation failed, try to recover
        if (!validationSuccess) {
            console.log('[GameEngine] KB context invalid or missing. Attempting recovery...');

            // Unified recovery logic
            if (hasLocalFiles) {
                console.log('[GameEngine] Re-creating Knowledge Base from local files...');
                const files = this.loadedFiles();
                const fileParts = this.buildKnowledgeBaseParts(files);
                const kbText = fileParts.map(p => p.text).join('');

                try {
                    if (useCache) {
                        const newHash = this.calculateKbHash(kbText);
                        let cacheRes: LLMCacheInfo | null = null;
                        if (this.provider.createCache) {
                            cacheRes = await this.provider.createCache(
                                config?.modelId || this.provider.getDefaultModelId(),
                                this.systemInstructionCache,
                                [{ role: 'user', parts: fileParts }],
                                ttlSeconds
                            );
                        }

                        if (cacheRes?.name) {
                            this.kbCacheName.set(cacheRes.name);
                            const expireTime = typeof cacheRes.expireTime === 'number'
                                ? cacheRes.expireTime
                                : Date.now() + ttlSeconds * 1000;
                            this.kbCacheExpireTime.set(expireTime);
                            localStorage.setItem('kb_cache_name', cacheRes.name);
                            localStorage.setItem('kb_cache_hash', newHash);
                            this.kbCacheTokens = cacheRes.usageMetadata?.totalTokenCount || 0;
                            localStorage.setItem('kb_cache_tokens', this.kbCacheTokens.toString());
                            this.startStorageTimer();
                            validationSuccess = true;
                            console.log('[GameEngine] Auto-cache creation successful:', cacheRes.name);
                        }
                    } else {
                        const blob = new Blob([kbText], { type: 'text/plain' });
                        if (this.provider.uploadFile) {
                            const { uri } = await this.provider.uploadFile(blob, 'text/plain');
                            fileUri = uri; // Assign to let variable

                            this.kbFileUri.set(uri);
                            localStorage.setItem('kb_file_uri', uri);
                            validationSuccess = true;
                            console.log('[GameEngine] Auto-file upload successful:', uri);
                        } else {
                            console.warn('Provider does not support file upload.');
                        }
                    }
                } catch (err) {
                    console.error(useCache ? '[GameEngine] Auto-cache creation failed:' : '[GameEngine] Auto-file upload failed:', err);
                }
            } else {
                // FALLBACK: Last ditch effort - check if the "other" method exists
                console.log('[GameEngine] No local files. Checking fallback context...');
                if (useCache && fileUri) {
                    let isStillAvailable = false;
                    if (this.provider.isFileAvailable) {
                        isStillAvailable = await this.provider.isFileAvailable(fileUri);
                    }

                    if (isStillAvailable) {
                        console.log('[GameEngine] Cache missing, but using existing File URI as fallback.');
                        validationSuccess = true;
                        // Note: kbCacheName was already cleared in Step 1
                    }
                } else if (!useCache && cacheName && this.provider.getCache) {
                    const status = await this.provider.getCache(cacheName);
                    if (status) {
                        console.log('[GameEngine] File missing, but using existing Cache as fallback.');
                        validationSuccess = true;
                        // Note: kbFileUri was already cleared in Step 1
                    }
                }
            }
        }

        // 3. Final failure check
        if (!validationSuccess) {
            console.error('[GameEngine] KB context lost and cannot be recovered.');
            this.kbCacheName.set(null);
            this.kbFileUri.set(null);
            localStorage.removeItem('kb_cache_name');
            localStorage.removeItem('kb_file_uri');
            throw new Error('SESSION_EXPIRED');
        }

        // 4. Proactive cleanup of "leftover" resources from the OTHER mode
        // If we reached here, validationSuccess is true for the CURRENT mode.
        try {
            if (useCache) {
                // We are in Cache mode. If there's a leftover File URI, clean it up.
                if (fileUri) {
                    console.log('[GameEngine] Cleaning up leftover File URI after successful Cache validation.');
                    if (this.provider.deleteAllFiles) {
                        await this.provider.deleteAllFiles(); // Delete all files to be thorough
                    }
                    this.kbFileUri.set(null);
                    localStorage.removeItem('kb_file_uri');
                }
            } else {
                // We are in File mode. If there's a leftover Cache, clean it up to save costs.
                if (cacheName) {
                    console.log('[GameEngine] Cleaning up leftover Cache after successful File validation.');
                    if (this.provider.deleteCache) {
                        await this.provider.deleteCache(cacheName);
                    }
                    this.kbCacheName.set(null);
                    this.kbCacheExpireTime.set(null);
                    this.kbCacheTokens = 0;
                    this.stopStorageTimer();
                    localStorage.removeItem('kb_cache_name');
                    localStorage.removeItem('kb_cache_hash');
                    localStorage.removeItem('kb_cache_tokens');
                }
            }
        } catch (cleanupErr) {
            console.warn('[GameEngine] Non-critical cleanup error during mode switch handover:', cleanupErr);
        }
    }

    /**
     * Clears all server-side caches and uploaded files, and resets the local session state.
     * @returns The number of caches deleted.
     */
    async clearAllServerCaches() {
        this.status.set('loading');
        try {
            console.log('Clearing ALL server-side caches and files...');
            let count = 0;
            if (this.provider.deleteAllCaches) {
                count = await this.provider.deleteAllCaches();
            }

            // ALSO delete all uploaded files
            if (this.provider.deleteAllFiles) {
                await this.provider.deleteAllFiles();
            }

            this.kbCacheName.set(null);
            this.kbCacheExpireTime.set(null);
            this.kbFileUri.set(null);
            this.storageCostAccumulated.set(0);
            this.historyStorageCostAccumulated.set(0);
            this.kbCacheTokens = 0;
            this.stopStorageTimer();

            localStorage.removeItem('kb_cache_name');
            localStorage.removeItem('kb_cache_expire');
            localStorage.removeItem('kb_cache_tokens');
            localStorage.removeItem('kb_cache_hash');
            localStorage.removeItem('kb_file_uri');
            localStorage.removeItem('history_storage_cost_acc');
            localStorage.removeItem('storage_cost_acc');
            localStorage.removeItem('estimated_cost');
            localStorage.removeItem('usage_stats');

            // ALSO Clear History (Restart Session) to prevent sending requests with invalid state
            await this.clearHistory();

            this.status.set('idle');
            return count;
        } catch (e) {
            console.error('Failed to clear all server data:', e);
            this.status.set('error');
            return 0;
        }
    }

    /**
     * Manually releases the active context cache on the server while preserving chat history.
     */
    async releaseCache() {
        const cacheName = this.kbCacheName();
        if (cacheName) {
            console.log('[GameEngine] Manually releasing cache:', cacheName);
            try {
                // Add current to history before release
                const currentAcc = this.storageCostAccumulated();
                if (currentAcc > 0) {
                    this.historyStorageCostAccumulated.update(v => v + currentAcc);
                }

                if (this.provider.deleteCache) {
                    await this.provider.deleteCache(cacheName);
                }
            } catch (err) {
                console.error('[GameEngine] Failed to delete cache from server:', err);
            }
        }

        // Clear local state
        this.kbCacheName.set(null);
        this.kbCacheExpireTime.set(null);
        this.storageCostAccumulated.set(0);
        this.kbCacheTokens = 0;
        this.stopStorageTimer();

        localStorage.removeItem('kb_cache_name');
        localStorage.removeItem('kb_cache_expire');
        localStorage.removeItem('kb_cache_tokens');
        localStorage.removeItem('kb_cache_hash');
        localStorage.removeItem('storage_cost_acc');

        console.log('[GameEngine] Cache released successfully.');
    }

    /**
     * Completely wipes all local game progress, including IndexedDB stores and signals.
     */
    async wipeLocalSession() {
        console.log('[GameEngine] Wiping local session...');
        // Use status instead of isBusy (which is computed)
        this.status.set('loading');
        try {
            // 1. Clear all IndexedDB stores
            await this.storage.clear(); // chat_store
            await this.storage.clearFiles(); // file_store

            // 2. Reset all signals and local state
            this.messages.set([]);
            this.loadedFiles.set(new Map());
            this.kbCacheName.set(null);
            this.kbCacheExpireTime.set(null);
            this.kbCacheTokens = 0;
            this.stopStorageTimer();

            // Clear localStorage
            localStorage.removeItem('kb_cache_name');
            localStorage.removeItem('kb_cache_expire');
            localStorage.removeItem('kb_cache_tokens');
            localStorage.removeItem('kb_cache_hash');
            localStorage.removeItem('storage_cost_acc');

            // Reset other signals with correct names found in the service
            this.tokenUsage.set({ freshInput: 0, cached: 0, output: 0, total: 0 });
            this.estimatedKbTokens.set(0);
            this.estimatedCost.set(0);
            this.lastTurnUsage.set(null);
            this.lastTurnCost.set(0);
            this.historyStorageCostAccumulated.set(0);
            this.currentKbHash.set('');

            console.log('[GameEngine] Local session wiped successfully.');
        } catch (e) {
            console.error('Failed to wipe local session', e);
            throw e;
        } finally {
            this.status.set('idle');
        }
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
    }, scenarioId: string) {
        this.status.set('generating');
        try {
            console.log(`[GameEngine] Starting New Game (${scenarioId}) with profile:`, profile);

            const names = getCoreFilenames(this.config()?.outputLanguage);
            // Collect all unique filenames from all locales to check availability
            const coreKeys: (keyof typeof names)[] = [
                'BASIC_SETTINGS', 'STORY_OUTLINE', 'CHARACTER_STATUS',
                'ASSETS', 'TECH_EQUIPMENT', 'WORLD_FACTIONS',
                'MAGIC', 'PLANS', 'INVENTORY'
            ];

            const loadedMap = new Map<string, string>();

            const replacements = [
                { pattern: /<!uc_name(?:\|[^>]+)?>/g, replacement: profile.name },
                { pattern: /<!uc_faction(?:\|[^>]+)?>/g, replacement: profile.faction },
                { pattern: /<!uc_background(?:\|[^>]+)?>/g, replacement: profile.background },
                { pattern: /<!uc_interests(?:\|[^>]+)?>/g, replacement: profile.interests },
                { pattern: /<!uc_appearance(?:\|[^>]+)?>/g, replacement: profile.appearance },
                { pattern: /<!uc_core_values(?:\|[^>]+)?>/g, replacement: profile.coreValues },
            ];

            for (const key of coreKeys) {
                // Find which filename variant exists for this key
                const potentialFilenames = new Set(Object.values(LOCALES).map(l => l.coreFilenames[key]));
                let content = '';
                let foundFilename = '';

                for (const filename of potentialFilenames) {
                    try {
                        content = await this.fileSystem.getFallbackContent(`assets/system_files/scenario/${scenarioId}/${filename}`);
                        if (content) {
                            foundFilename = filename;
                            break;
                        }
                    } catch {
                        // Continue checking other variants
                    }
                }

                if (!content || !foundFilename) {
                    console.warn(`[GameEngine] Failed to load ${key} from any locale for scenario ${scenarioId}`);
                    // Fallback to default language filename just to prevent total crash, though likely empty
                    foundFilename = names[key];
                    content = '';
                }

                // Apply specific profile replacements
                for (const r of replacements) {
                    content = content.replace(r.pattern, r.replacement);
                }

                // Robust Cleanup: Replace any remaining <!tag|default|label> or <!tag|default> with their default text
                // then replace any remaining <!tag> with empty string to avoid showing variables
                content = content.replace(/<![^|>]+(?:\|([^|>]*))?(?:\|[^>]+)?>/g, (match, def) => def ? def.trim() : '');

                // Story Outline: Inject last_scene marker for startup
                // Check if this IS the Story Outline file (in any language)
                const matchedLocale = Object.values(LOCALES).find(l => l.coreFilenames.STORY_OUTLINE === foundFilename);
                if (matchedLocale) {
                    const sceneHeaders = getSectionHeaders(matchedLocale.id);
                    const startSceneHeader = sceneHeaders.START_SCENE;

                    if (content.includes(startSceneHeader)) {
                        const sceneContent = content.split(startSceneHeader)[1].split('---')[0].trim();
                        content += `\n\n# last_scene\n${sceneContent}`;
                    }
                }

                // Save to IndexedDB using the ACTUAL filename found
                await this.storage.saveFile(foundFilename, content);
                loadedMap.set(foundFilename, content);
            }

            // Update local state and clear history
            this.loadedFiles.set(loadedMap);
            this.messages.set([]);
            await this.storage.set('chat_history', []);
            this.isContextInjected = false;

            // Sync state
            await this.loadFiles(false);

            // Start session
            this.startSession();

            this.snackBar.open('新遊戲初始化完成！', 'OK', { duration: 3000 });

        } catch (e) {
            console.error('[GameEngine] Failed to initialize new game', e);
            this.snackBar.open('啟動失敗：無法載入初始場景檔案。', '關閉', { duration: 5000 });
            throw e;
        } finally {
            this.status.set('idle');
        }
    }

    /**
     * Initializes the story session by either extracting the last scene from '2.劇情綱要.md'
     * or prompting the AI to start the story.
     */
    startSession() {
        if (this.messages().length === 0) {
            const introText = `劇情開始，建構最後的場景`;

            // Optimization: Try to extract last scene locally to save API call and tokens
            // Optimization: Try to extract last scene locally to save API call and tokens
            // Find the loaded Story Outline file (checking all known locale variants)
            const potentialOutlineNames = new Set(Object.values(LOCALES).map(l => l.coreFilenames.STORY_OUTLINE));
            let fileName = '';
            let content: string | undefined;

            for (const name of potentialOutlineNames) {
                if (this.loadedFiles().has(name)) {
                    fileName = name;
                    content = this.loadedFiles().get(name);
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

            if (lastScene) {
                console.log('[GameEngine] Local Initialization: Extracted last_scene from', fileName);
                const userMsgId = crypto.randomUUID();
                const modelMsgId = crypto.randomUUID();

                // Detect language from file name to ensure Adult Declaration matches scenario language
                const matchedLocale = Object.values(LOCALES).find(l => l.coreFilenames.STORY_OUTLINE === fileName);
                const langId = matchedLocale ? matchedLocale.id : (this.config()?.outputLanguage || 'default');
                const declaration = getAdultDeclaration(langId);

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
                        analysis: `系統本地初始化：已從劇情綱要讀取最後場景。`
                    }
                ]);
            } else {
                console.warn('[GameEngine] Local Initialization Failed: No marker found or file empty.');

                // Clear state
                this.loadedFiles.set(new Map());
                this.kbFileUri.set(null);
                this.estimatedKbTokens.set(0);

                const modelMsgId = crypto.randomUUID();
                this.updateMessages(prev => [
                    ...prev,
                    {
                        id: modelMsgId,
                        role: 'model',
                        content: `❌ 存檔載入失敗：在 \`${fileName}\` 中找不到 \`last_scene\` 標記，或檔案內容無效。已重設載入狀態。`,
                        isRefOnly: true
                    }
                ]);

                this.snackBar.open(`載入失敗：找不到劇情標記，請檢查檔案內容。`, `關閉`, {
                    duration: 5000,
                    panelClass: ['snackbar-error']
                });
            }
        }
    }

    /**
     * Constructs the Part array for the Knowledge Base content from a file map.
     * @param files Map of file paths to content.
     * @returns Array of Part objects containing the file contents.
     */
    private buildKnowledgeBaseParts(files: Map<string, string>): LLMPart[] {
        const parts: LLMPart[] = [];
        files.forEach((content, path) => {
            // Exclude system prompt from context injection as it's already in systemInstruction
            if (!path.startsWith('system_files/') && path !== 'system_prompt.md') {
                let processedContent = content;
                // Strip last_scene from Story Outline
                const isStoryOutline = Object.values(LOCALES).some(l => l.coreFilenames.STORY_OUTLINE === path);

                if (isStoryOutline) {
                    const lastSceneRegex = /(?:^|\n)[#*_\s]*last[_-]?scene[#*_\s]*[:：]?[\s\S]*$/i;
                    processedContent = content.replace(lastSceneRegex, '').trim();
                }
                parts.push({ text: `${LLM_MARKERS.FILE_CONTENT_SEPARATOR} [${path}] ---\\n${processedContent}\\n\\n` });
            }
        });
        return parts;
    }

    /**
     * Constructs the JSON payload that will be sent to the Gemini API for preview purposes.
     * @param userText The user's input text.
     * @param options Optional intent and other metadata.
     * @returns The constructed payload object.
     */
    getPreviewPayload(userText: string, options?: { intent?: string }) {
        const userMsgContent = (options?.intent || '') + userText;

        const history = this.getLLMHistory(); // This is the history BEFORE the new message
        let finalContent: LLMContent[] = [...history, { role: 'user', parts: [{ text: userMsgContent }] }];

        // Allow provider to customize preview (e.g. remove thoughtSignature)
        if (this.provider.getPreview) {
            finalContent = this.provider.getPreview(finalContent);
        }

        const config = this.config();
        const modelId = config?.modelId || this.provider.getDefaultModelId();

        // Construct the generation config
        const generationConfig: LLMGenerateConfig = {
            responseMimeType: 'application/json',
            responseSchema: getResponseSchema(config?.outputLanguage)
        };

        const cachedContentName = this.kbCacheName() || undefined;
        if (cachedContentName) {
            generationConfig.cachedContentName = cachedContentName;
        }

        return {
            model: modelId,
            contents: finalContent,
            config: generationConfig,
            systemInstruction: this.getEffectiveSystemInstruction() // Add this explicitly for visibility
        };
    }

    /**
     * Sends a message to the Gemini API and updates the chat history in real-time.
     * Handles streaming responses, JSON parsing, and automatic archiving of old turns.
     * @param userText The user's input text.
     * @param options Optional flags for hidden messages or specific intents.
     */
    async sendMessage(userText: string, options?: { isHidden?: boolean, intent?: string }) {
        if (!userText.trim()) return;

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

        this.status.set('generating');

        // 2. Ensure cache is valid before generating
        try {
            await this.checkCacheAndRefresh();
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
            this.status.set('idle');
            return;
        }

        try {
            const history = this.getLLMHistory(forceFullContext);

            // Dynamic Injection Logic (Always enabled - command rules are in injection files)
            const currentIntent = options?.intent || GAME_INTENTS.ACTION;

            let injectionContent = '';
            if (currentIntent === GAME_INTENTS.ACTION) {
                injectionContent = this.dynamicActionInjection();
            } else if (currentIntent === GAME_INTENTS.CONTINUE) {
                injectionContent = this.dynamicContinueInjection();
            } else if (currentIntent === GAME_INTENTS.FAST_FORWARD) {
                injectionContent = this.dynamicFastforwardInjection();
            } else if (currentIntent === GAME_INTENTS.SYSTEM) {
                injectionContent = this.dynamicSystemInjection();
            } else if (currentIntent === GAME_INTENTS.SAVE) {
                injectionContent = this.dynamicSaveInjection();
            }

            if (injectionContent) {
                console.log(`[GameEngine] Injecting Dynamic Prompt for ${currentIntent}`);
                console.log(`[GameEngine] Injecting Dynamic Prompt for ${currentIntent}`);
                // Insert prompt BEFORE the last user message
                if (history.length > 0) {
                    const lastMsg = history.pop(); // Remove last user msg
                    history.push({
                        role: 'user',
                        parts: [{ text: injectionContent }]
                    });
                    if (lastMsg) history.push(lastMsg); // Put user msg back
                }
            }

            const stream = this.provider.generateContentStream(
                history,
                this.getEffectiveSystemInstruction(),
                {
                    cachedContentName: this.kbCacheName() || undefined,
                    responseSchema: getResponseSchema(this.config()?.outputLanguage),
                    responseMimeType: 'application/json'
                }
            );

            let currentJSONAccumulator = '';
            let currentStoryPreview = '';
            let currentAnalysisPreview = '';
            let currentThought = '';
            let turnUsage = { prompt: 0, candidates: 0, cached: 0 };
            const lastUserIntent = options?.intent || GAME_INTENTS.ACTION;
            const modelMsgId = crypto.randomUUID();

            // Accumulators for Gemini 3 features
            const capturedFCs: ExtendedPart[] = [];
            let capturedThoughtSignature: string | undefined;

            this.updateMessages(prev => [...prev, { id: modelMsgId, role: 'model', content: '', thought: '', isThinking: true }]);

            for await (const chunk of stream) {
                // Flatten stream structure (LLMStreamChunk)
                const part: LLMStreamChunk = chunk; // Typed alias
                const extPart = part; // Alias

                // Capture Thought Signature (from ANY part)
                if (extPart.thoughtSignature) {
                    capturedThoughtSignature = extPart.thoughtSignature;
                }

                // Handle Function Calls (Preserve them)
                if (part.functionCall) {
                    capturedFCs.push(extPart);
                }

                // Handle Text / Thinking
                if (part.text) {
                    if ((part as ThoughtPart).thought) {
                        currentThought += part.text;
                        // Update UI for real-time thinking
                        this.updateMessages(prev => {
                            const arr = [...prev];
                            if (arr[arr.length - 1]?.role === 'model') {
                                arr[arr.length - 1].thought = currentThought;
                            }
                            return arr;
                        });
                    } else {
                        currentJSONAccumulator += part.text;

                        // STREAMING PARSER: Extract 'analysis' field content for immediate display
                        const analysisMatch = /"analysis"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(currentJSONAccumulator);
                        if (analysisMatch && analysisMatch[1]) {
                            const rawAnalysis = analysisMatch[1];
                            try {
                                currentAnalysisPreview = rawAnalysis
                                    .replace(/\\n/g, '\n')
                                    .replace(/\\"/g, '"')
                                    .replace(/\\\\/g, '\\');
                            } catch {
                                // Ignore parsing errors during streaming
                            }
                        }

                        // STREAMING PARSER: Extract 'story' field content for immediate display
                        const storyMatch = /"story"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(currentJSONAccumulator);
                        if (storyMatch && storyMatch[1]) {
                            const rawStory = storyMatch[1];
                            try {
                                currentStoryPreview = rawStory
                                    .replace(/\\n/g, '\n')
                                    .replace(/\\"/g, '"')
                                    .replace(/\\\\/g, '\\');
                            } catch {
                                // Ignore parsing errors during streaming
                            }
                        }
                    }
                }

                this.updateMessages(prev => {
                    const arr = [...prev];
                    if (arr[arr.length - 1]?.role === 'model') {
                        arr[arr.length - 1] = {
                            ...arr[arr.length - 1],
                            content: currentStoryPreview,
                            analysis: currentAnalysisPreview,
                            isThinking: true
                        };
                    }
                    return arr;
                });
                // End flattened loop

                if (chunk.usageMetadata) {
                    turnUsage = {
                        prompt: chunk.usageMetadata.promptTokens || 0,
                        candidates: chunk.usageMetadata.completionTokens || 0,
                        cached: chunk.usageMetadata.cachedTokens || 0
                    };
                }
            }

            // Finalize: Parse the full JSON (expects nested format: analysis -> response)
            let finalAnalysis = '';
            let finalStory = currentStoryPreview;
            let finalSummary = '';
            let finalInventoryLog: string[] = [];
            let finalQuestLog: string[] = [];
            let finalWorldLog: string[] = [];
            let isCorrection = false;

            try {
                const parsed = this.bestEffortJsonParser(currentJSONAccumulator) as Partial<EngineResponseNested>;

                if (parsed.analysis) finalAnalysis = this.processModelField(parsed.analysis);

                if (parsed.response) {
                    if (parsed.response.story) finalStory = this.processModelField(parsed.response.story);
                    if (parsed.response.summary) finalSummary = this.processModelField(parsed.response.summary);

                    if (Array.isArray(parsed.response.inventory_log) && parsed.response.inventory_log.length > 0) {
                        finalInventoryLog = parsed.response.inventory_log.map(i => this.processModelField(i));
                    }
                    if (Array.isArray(parsed.response.quest_log) && parsed.response.quest_log.length > 0) {
                        finalQuestLog = parsed.response.quest_log.map(q => this.processModelField(q));
                    }
                    if (Array.isArray(parsed.response.world_log) && parsed.response.world_log.length > 0) {
                        finalWorldLog = parsed.response.world_log.map(w => this.processModelField(w));
                    }

                    if (parsed.response.isCorrection) isCorrection = true;
                }
            } catch (jsonErr) {
                console.error('[GameEngine] Best-effort JSON Parse Failed:', jsonErr);
                console.error('[GameEngine] Raw Accumulator (first 500 chars):', currentJSONAccumulator.substring(0, 500));
                // Don't put raw JSON into analysis - leave it empty or use a placeholder
                finalAnalysis = '';
                finalStory = currentStoryPreview || `⚠️ 模型輸出格式異常，請重試。`;
            }

            // Post-Process Correction: Mark the last story-type model message as ref-only
            let correctedIntent: string | undefined;
            if (isCorrection) {
                const storyIntents = [GAME_INTENTS.ACTION, GAME_INTENTS.CONTINUE, GAME_INTENTS.FAST_FORWARD];
                console.log('[GameEngine] Correction detected. Looking for last model message with story-type intent.');
                this.updateMessages(prev => {
                    const updated = [...prev];
                    // Find the last model message with story-type intent (skip current being added)
                    for (let i = updated.length - 2; i >= 0; i--) {
                        const msg = updated[i];
                        if (msg.role === 'model' && !msg.isRefOnly && msg.intent && (storyIntents as string[]).includes(msg.intent)) {
                            msg.isRefOnly = true;
                            correctedIntent = msg.intent;
                            console.log('[GameEngine] Marked story model message as ref-only:', msg.id, 'Intent:', correctedIntent);
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
                            if (currentThought) parts.push({ thought: true, text: currentThought });
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
                        thought: currentThought,
                        summary: finalSummary,
                        inventory_log: finalInventoryLog,
                        quest_log: finalQuestLog,
                        world_log: finalWorldLog,
                        usage: turnUsage,
                        intent: isCorrection ? (correctedIntent || GAME_INTENTS.ACTION) : lastUserIntent,
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

            const fresh = turnUsage.prompt - turnUsage.cached;
            this.lastTurnUsage.set({
                freshInput: fresh,
                cached: turnUsage.cached,
                output: turnUsage.candidates
            });

            const turnCost = this.calculateTurnCost(turnUsage);
            this.lastTurnCost.set(turnCost);

            this.tokenUsage.update(prev => {
                return {
                    freshInput: prev.freshInput + fresh,
                    cached: prev.cached + turnUsage.cached,
                    output: prev.output + turnUsage.candidates,
                    total: prev.total + turnUsage.prompt + turnUsage.candidates
                };
            });
            this.estimatedCost.update(prev => prev + turnCost);

            console.log(`[GameEngine] Turn Usage Breakdown:
- FRESH Input (Not in Cache): ${fresh.toLocaleString()} tokens
  (Includes Chat History + Tool Outputs + System Instructions not in KB)
- CACHED Input (Knowledge Base): ${turnUsage.cached.toLocaleString()} tokens
- Output: ${turnUsage.candidates.toLocaleString()} tokens
- Turn Cost: $${turnCost.toFixed(5)}`);

            this.status.set('idle');
        } catch (e: unknown) {
            console.error(e);
            this.status.set('error');

            const errMsg = (e instanceof Error) ? e.message : '連線發生錯誤，請稍後再試。';
            this.updateMessages(prev => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last && last.role === 'model' && last.isThinking) {
                    last.content = `❌ 發生錯誤: ${errMsg}`;
                    last.isThinking = false;
                    last.isRefOnly = true; // Auto-mark as RefOnly to prevent pollution
                } else {
                    updated.push({ id: crypto.randomUUID(), role: 'model', content: `❌ 發生錯誤: ${errMsg}`, isRefOnly: true });
                }

                // Show UI Toast
                this.snackBar.open(`Generation Failed: ${errMsg}`, `Close`, {
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
                    resultMessage = `劇情已修正 (ID: ${arr[i].id})`;
                    break;
                }
            }

            if (!found) {
                resultMessage = `找不到可修正的劇情訊息。`;
            }

            return arr;
        });
        return resultMessage;
    }

    /**
     * Updates the content of a specific message by ID.
     * @param id The message ID.
     * @param newContent The new text content.
     */
    updateMessageContent(id: string, newContent: string) {
        this.messages.update(msgs => {
            return msgs.map(m => {
                if (m.id === id) {
                    return { ...m, content: newContent };
                }
                return m;
            });
        });
        // Persist change
        this.storage.set('chat_history', this.messages());
    }

    /**
     * Updates the logs (inventory, quest or world) of a specific message by ID.
     * @param id The message ID.
     * @param type The type of log to update ('inventory' | 'quest' | 'world').
     * @param logs The new array of log strings.
     */
    updateMessageLogs(id: string, type: 'inventory' | 'quest' | 'world', logs: string[]) {
        this.messages.update(msgs => {
            return msgs.map(m => {
                if (m.id === id) {
                    const updates: Partial<ChatMessage> = {};
                    if (type === 'inventory') {
                        updates.inventory_log = logs;
                    } else if (type === 'quest') {
                        updates.quest_log = logs;
                    } else if (type === 'world') {
                        updates.world_log = logs;
                    }
                    return { ...m, ...updates };
                }
                return m;
            });
        });
        // Persist change
        this.storage.set('chat_history', this.messages());
    }

    /**
     * Updates the narrative summary of a specific message by ID.
     * @param id The message ID.
     * @param summary The new summary text.
     */
    updateMessageSummary(id: string, summary: string) {
        this.messages.update(msgs => {
            return msgs.map(m => {
                if (m.id === id) {
                    return { ...m, summary };
                }
                return m;
            });
        });
        // Persist change
        this.storage.set('chat_history', this.messages());
    }

    /**
     * Deletes a specific message from the chat history.
     * @param id The ID of the message to delete.
     */
    deleteMessage(id: string) {
        this.updateMessages(prev => {
            const arr = [...prev];
            const index = arr.findIndex(m => m.id === id);
            if (index !== -1) {
                arr.splice(index, 1);
            }
            return arr;
        });
    }

    /**
     * Deletes all messages from a specific message onwards (inclusive).
     * @param id The ID of the starting message to delete.
     */
    deleteFrom(id: string) {
        this.updateMessages(prev => {
            const arr = [...prev];
            const index = arr.findIndex(m => m.id === id);
            if (index !== -1) {
                arr.splice(index);
            }
            return arr;
        });
    }

    /**
     * Rewinds the story history to just before a specific message.
     * @param messageId The ID of the message to rewind to.
     */
    rewindTo(messageId: string) {
        this.updateMessages(prev => {
            const arr = [...prev];
            const index = arr.findIndex(m => m.id === messageId);
            if (index !== -1) {
                arr.splice(index);
                console.log(`[GameEngine] Rewound history to before message ${messageId} (Deleted ${prev.length - arr.length} messages)`);
            }
            return arr;
        });
    }

    /**
     * Toggles a message's 'Reference Only' status, excluding or including it in AI context.
     * @param id The ID of the message.
     */
    toggleRefOnly(id: string) {
        this.updateMessages(prev => {
            const arr = [...prev];
            const index = arr.findIndex(m => m.id === id);
            if (index !== -1) {
                arr[index] = {
                    ...arr[index],
                    isRefOnly: !arr[index].isRefOnly,
                    isManualRefOnly: true // Mark as manually changed to prevent auto-overwrites
                };
            }
            return arr;
        });
    }

    /**
     * Clears all local chat history and usage stats.
     */
    async clearHistory() {
        this.messages.set([]);

        // Reset Usage Stats for new session
        this.tokenUsage.set({ freshInput: 0, cached: 0, output: 0, total: 0 });
        this.lastTurnCost.set(0);
        this.estimatedCost.set(0);
        this.storageCostAccumulated.set(0);
        this.historyStorageCostAccumulated.set(0);

        // Clear persisted stats
        localStorage.removeItem('usage_stats');
        localStorage.removeItem('estimated_cost');
        localStorage.removeItem('storage_cost_acc');
        localStorage.removeItem('history_storage_cost_acc');

        await this.storage.delete('chat_history');
        this.status.set('idle');
    }

    /**
     * Updates the chat history state and persists it to local storage.
     * @param updater Functional update to the message list.
     */
    private updateMessages(updater: (prev: ChatMessage[]) => ChatMessage[]) {
        const newVal = updater(this.messages());
        this.messages.set(newVal);
        this.storage.set('chat_history', newVal);
    }

    /**
     * Constructs the chat history in a provider-agnostic format.
     * Handles smart context consolidation and Knowledge Base injection.
     * @returns Array of Content objects.
     */
    private getLLMHistory(forceFullContext = false): LLMContent[] {
        const all = this.messages();
        // Filter out RefOnly, but keep tool responses
        const filtered = all.filter(m => !m.isRefOnly || m.parts?.some(p => p.functionResponse));

        // We want to keep the last few messages intact for immediate context flow.
        const RECENT_WINDOW = 20;

        // Use full context if forced (e.g., save commands) or if contextMode is 'full'
        const useFullContext = forceFullContext || this.contextMode() === 'full';
        const splitIndex = useFullContext ? 0 : Math.max(0, filtered.length - RECENT_WINDOW);

        const pastMessages = filtered.slice(0, splitIndex);
        const recentMessages = filtered.slice(splitIndex);

        // 1. Consolidate Past Summaries
        let historicalContext = '';
        if (!useFullContext && pastMessages.length > 0) {
            pastMessages.forEach(m => {
                if (m.role === 'model') {
                    // Synthesize summary from history: Narrative + Inventory + Quest
                    let turnSummary = m.summary || '';
                    const stateUpdates: string[] = [];
                    if (m.inventory_log && m.inventory_log.length > 0) {
                        stateUpdates.push(`[物品或資產: ${m.inventory_log.join(', ')}]`);
                    }
                    if (m.quest_log && m.quest_log.length > 0) {
                        stateUpdates.push(`[任務或事件: ${m.quest_log.join(', ')}]`);
                    }
                    if (m.world_log && m.world_log.length > 0) {
                        stateUpdates.push(`[世界或勢力: ${m.world_log.join(', ')}]`);
                    }

                    if (stateUpdates.length > 0) {
                        turnSummary += (turnSummary ? ' ' : '') + stateUpdates.join(' ');
                    }

                    if (turnSummary) {
                        // Extract Header (Date/Location) if present
                        // Generic match for any calendar format containing "Year"/"Month"/"Day"
                        // Matches: [Anything Year Month Day ...]
                        const headerMatch = m.content.match(/\[\s*[^\]]*\d+年\s*\d+月\d+日[^\]]*\]/);
                        const baseHeader = headerMatch ? headerMatch[0] : '';

                        // Extract all [T XXX] time markers across the entire message content
                        const tMatches = [...m.content.matchAll(/\[T\s*([^\]]+)\]/g)];
                        let timeHeader = '';
                        if (tMatches.length > 1) {
                            // If multiple markers exist (e.g., spans across time), format as range
                            const start = tMatches[0][1].trim();
                            const end = tMatches[tMatches.length - 1][1].trim();
                            timeHeader = `[T ${start}~T ${end}]`;
                        } else if (tMatches.length === 1) {
                            // Just use the single marker found
                            timeHeader = tMatches[0][0];
                        }

                        const finalHeader = [baseHeader, timeHeader].filter(h => !!h).join(' ');
                        historicalContext += (finalHeader ? `${finalHeader} ` : '') + `${turnSummary}\n`;
                    }
                }
            });
        }

        // 2. Build Recent History (Standard Format)
        const llmHistory: LLMContent[] = recentMessages.map(m => {
            const parts: LLMPart[] = [];
            if (m.parts && m.parts.length > 0) {
                m.parts.forEach(p => {
                    // Skip internal thought parts ONLY if they don't carry a required signature
                    if ((p as ExtendedPart).thought && !(p as ExtendedPart).thoughtSignature) return;
                    // Skip existing file/context parts matches (to avoid duplication if re-injecting)
                    if (p.fileData && p.fileData.fileUri === this.kbFileUri()) return;
                    if (p.text && p.text.startsWith(LLM_MARKERS.FILE_CONTENT_SEPARATOR)) return;
                    if (p.text && p.text.startsWith(LLM_MARKERS.SYSTEM_RULE_SEPARATOR)) return;

                    parts.push({ ...p });
                });
            }
            // Fallback if parts are empty (e.g. legacy or stripped)
            if (parts.length === 0 && m.content) {
                parts.push({ text: m.content });
            }

            // For model messages: Append Turn Update (summary, inventory_log, quest_log)
            // This ensures LLM sees previous state changes and doesn't regenerate them
            if (m.role === 'model') {
                const turnUpdateParts: string[] = [];

                if (m.summary) {
                    turnUpdateParts.push(`Turn Summary: ${m.summary}`);
                }
                if (m.inventory_log && m.inventory_log.length > 0) {
                    turnUpdateParts.push(`Inventory Changes: ${m.inventory_log.join(', ')}`);
                }
                if (m.quest_log && m.quest_log.length > 0) {
                    turnUpdateParts.push(`Plan & Quest Updates: ${m.quest_log.join(', ')}`);
                }
                if (m.world_log && m.world_log.length > 0) {
                    turnUpdateParts.push(`World & Setting Updates: ${m.world_log.join(', ')}`);
                }

                if (turnUpdateParts.length > 0) {
                    // Find last text part (non-thought) and append
                    let lastTextPartIndex = -1;
                    for (let i = parts.length - 1; i >= 0; i--) {
                        if (parts[i].text !== undefined && !(parts[i] as ExtendedPart).thought) {
                            lastTextPartIndex = i;
                            break;
                        }
                    }

                    if (lastTextPartIndex !== -1) {
                        parts[lastTextPartIndex] = {
                            ...parts[lastTextPartIndex],
                            text: parts[lastTextPartIndex].text + '\n\n---\n' + turnUpdateParts.join('\n') + '\n---'
                        };
                    } else {
                        parts.push({ text: '\n---\n' + turnUpdateParts.join('\n') + '\n---' });
                    }
                }
            }

            return { role: m.role, parts };
        });

        // 3. Inject Historical Context into the First Message
        if (historicalContext.trim()) {
            const contextBlock = `\n--- Historical Context Summary ---\n${historicalContext.trim()}\n---`;

            if (llmHistory.length > 0) {
                const firstMsg = llmHistory[0];

                const msgParts = firstMsg.parts || [];
                let targetPart = msgParts.find(p => p.text !== undefined);
                if (!targetPart) {
                    targetPart = { text: '' };
                    msgParts.unshift(targetPart);
                }

                // Prepend context
                targetPart.text = contextBlock + (targetPart.text || '');
                firstMsg.parts = msgParts;
            } else {
                // If no recent messages (rare?), create one
                llmHistory.push({ role: 'user', parts: [{ text: contextBlock }] });
            }
            console.log(`[GameEngine] Consolidated ${pastMessages.length} past messages into a single context block.`);
        }

        // 4. DYNAMIC CONTEXT INJECTION (Files/KB)
        // If NOT using Cache, we must manually inject the context (File or Text) into the first message
        // This is separate from Historical Context.
        if (!this.kbCacheName()) {
            let contextParts: LLMPart[] = [];

            if (this.kbFileUri()) {
                contextParts.push({
                    fileData: {
                        fileUri: this.kbFileUri()!,
                        mimeType: 'text/plain'
                    }
                });
            } else if (this.loadedFiles().size > 0) {
                contextParts = this.buildKnowledgeBaseParts(this.loadedFiles());
            }

            if (contextParts.length > 0) {
                if (llmHistory.length > 0) {
                    const firstMsg = llmHistory[0];
                    if (firstMsg.role === 'user') {
                        const msgParts = firstMsg.parts || [];
                        firstMsg.parts = [...contextParts, ...msgParts];
                    } else {
                        llmHistory.unshift({ role: 'user', parts: contextParts });
                    }
                } else {
                    llmHistory.push({ role: 'user', parts: contextParts });
                }
                console.log('[GameEngine] Dynamically injected KB context into history.');
            }
        }

        console.log('[GameEngine] Final History Construction:', llmHistory.map(m => ({ role: m.role, preview: m.parts?.[0]?.text?.substring(0, 50) + '...' })));

        return llmHistory;
    }

    /**
     * Trims and unescapes literal \n, \t, etc. from model response strings.
     * Some models double-escape characters, especially in specialized fields.
     * @param text The raw input text.
     * @returns The cleaned text.
     */
    private processModelField(text: string | undefined): string {
        if (!text) return '';
        return text
            .trim()
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }

    /**
     * Attempts to parse JSON from AI response using best-effort-json-parser.
     * This handles incomplete or truncated JSON from LLM responses.
     * @param text The raw response text.
     * @returns The parsed JSON object or an empty object on failure.
     */
    private bestEffortJsonParser(text: string): object {
        let cleanJson = text.trim();

        // 1. Try to extract JSON from markdown code blocks if present
        const markdownMatch = /```(?:json)?\s*([\s\S]*?)\s*```/g.exec(cleanJson);
        if (markdownMatch && markdownMatch[1]) {
            cleanJson = markdownMatch[1].trim();
        }

        // 2. Try to find the first '{' and last '}' to strip any surrounding text
        const jsonStart = cleanJson.indexOf('{');
        const jsonEnd = cleanJson.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
            cleanJson = cleanJson.substring(jsonStart, jsonEnd + 1);
        } else if (jsonStart !== -1) {
            // If there's no closing brace, take from start to end (truncated JSON)
            cleanJson = cleanJson.substring(jsonStart);
        }

        // Use best-effort-json-parser for robust parsing of incomplete JSON
        const result = parseJson(cleanJson);
        if (result && typeof result === 'object') {
            return result;
        }
        return {};
    }
    // ------------------------------------------------------------------------
    // Converters
    // ------------------------------------------------------------------------

    // Converters removed as we now use LLMContent/LLMPart natively
}
