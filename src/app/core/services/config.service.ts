import { Injectable, effect, inject } from '@angular/core';
import { GameStateService, GameEngineConfig } from './game-state.service';
import { StorageService } from './storage.service';
import { SessionService } from './session.service';
import { CacheManagerService } from './cache-manager.service';
import { InjectionService } from './injection.service';
import { CostService } from './cost.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';

@Injectable({
    providedIn: 'root'
})
export class ConfigService {
    private state = inject(GameStateService);
    private storage = inject(StorageService);
    private session = inject(SessionService);
    private cacheManager = inject(CacheManagerService);
    private injection = inject(InjectionService);
    private cost = inject(CostService);
    private providerRegistry = inject(LLMProviderRegistryService);

    private get provider() {
        return this.providerRegistry.getActive();
    }

    constructor() {
        // ==================== Auto-save Effects ====================

        // Sync CSS Variables with Config
        effect(() => {
            const cfg = this.state.config();
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
            const usage = this.state.tokenUsage();
            localStorage.setItem('usage_stats', JSON.stringify(usage));
        });
        effect(() => {
            const acc = this.state.storageUsageAccumulated();
            if (acc > 0) {
                // Save usage (Token-Seconds)
                localStorage.setItem('kb_storage_usage_acc', acc.toString());
            } else {
                localStorage.removeItem('kb_storage_usage_acc');
            }

            const hAcc = this.state.historyStorageUsageAccumulated();
            if (hAcc > 0) {
                localStorage.setItem('history_storage_usage_acc', hAcc.toString());
            } else {
                localStorage.removeItem('history_storage_usage_acc');
            }
        });

    }

    /**
     * Initializes the service by loading configuration and usage stats from localStorage.
     * Call this AFTER registering LLM Providers.
     */
    public async init() {
        // Trigger FX rate update (don't await to avoid blocking init)
        this.updateExchangeRateFromApi();

        // Initialize Injection Settings & History (Bootstrapping)
        await this.injection.loadDynamicInjectionSettings();
        await this.session.loadHistoryFromStorage();

        const key = localStorage.getItem('gemini_api_key');
        const model = localStorage.getItem('gemini_model_id') || this.provider?.getDefaultModelId() || 'gemini-prod';

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
        const idleOnBlur = localStorage.getItem('app_idle_on_blur') === 'true';
        const thinkingLevelStory = localStorage.getItem('gemini_thinking_level_story') || 'minimal';
        const thinkingLevelGeneral = localStorage.getItem('gemini_thinking_level_general') || 'high';
        const sSmartTurns = localStorage.getItem('gemini_smart_context_turns');
        const smartContextTurns = sSmartTurns ? parseInt(sSmartTurns, 10) : 10;

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
                outputLanguage,
                idleOnBlur,
                thinkingLevelStory,
                thinkingLevelGeneral,
                smartContextTurns
            };
            this.state.config.set(cfg);

            this.provider?.init({
                apiKey: key,
                modelId: model
            });

            // Restore cache state
            const cacheName = localStorage.getItem('kb_cache_name');
            console.log('[ConfigService] initConfig Read:', { name: cacheName });

            if (cacheName) {
                this.state.kbCacheName.set(cacheName);
                const savedTokens = localStorage.getItem('kb_cache_tokens');
                this.state.kbCacheTokens.set(savedTokens ? parseInt(savedTokens, 10) : 0);

                const savedExpire = localStorage.getItem('kb_cache_expire');
                if (savedExpire) {
                    const expireMs = parseInt(savedExpire, 10);
                    if (!isNaN(expireMs) && expireMs > Date.now()) {
                        this.state.kbCacheExpireTime.set(expireMs);
                        console.log('[ConfigService] Restored cache expiration from storage:', new Date(expireMs).toLocaleString());
                        this.cacheManager.startStorageTimer();
                    }
                }

                // Fetch fresh status from API to ensure reliability
                if (this.provider?.getCache) {
                    this.provider.getCache(cacheName).then(cacheStatus => {
                        if (cacheStatus && cacheStatus.expireTime) {
                            const expireMs = typeof cacheStatus.expireTime === 'number'
                                ? cacheStatus.expireTime
                                : new Date(cacheStatus.expireTime).getTime();
                            this.state.kbCacheExpireTime.set(expireMs);
                            localStorage.setItem('kb_cache_expire', expireMs.toString());
                            console.log('[ConfigService] Synced cache state from API:', cacheName, 'Expires at:', new Date(expireMs).toLocaleString());
                            this.cacheManager.startStorageTimer();
                        } else {
                            console.warn('[ConfigService] Saved cache not found on server or expired:', cacheName);
                            this.state.kbCacheName.set(null);
                            localStorage.removeItem('kb_cache_name');
                            localStorage.removeItem('kb_cache_hash');
                            localStorage.removeItem('kb_cache_expire');
                        }
                    });
                }
            }

            // Restore Usage Stats
            const savedUsage = localStorage.getItem('usage_stats');
            if (savedUsage) {
                try {
                    this.state.tokenUsage.set(JSON.parse(savedUsage));
                } catch (err) {
                    console.warn('Failed to parse saved usage stats', err);
                }
            }
            const savedStorageUsage = localStorage.getItem('kb_storage_usage_acc');
            if (savedStorageUsage) {
                this.state.storageUsageAccumulated.set(parseFloat(savedStorageUsage));
            }

            const savedHistoryUsage = localStorage.getItem('history_storage_usage_acc');
            if (savedHistoryUsage) {
                this.state.historyStorageUsageAccumulated.set(parseFloat(savedHistoryUsage));
            }
            // Sync files from DB on startup
            this.session.loadFiles(false);
        }
    }

    /**
     * Finds the Active Provider and updates the Exchange Rate.
     */
    private async updateExchangeRateFromApi() {
        await this.cost.updateExchangeRateFromApi();
        const rate = this.cost.exchangeRate();
        this.state.config.update(cfg => cfg ? { ...cfg, exchangeRate: rate } : null);
    }

    /**
     * Saves application configuration to localStorage and updates the engine state.
     */
    async saveConfig(apiKey: string, modelId: string, genConfig: {
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
        smartContextTurns?: number
    }) {
        localStorage.setItem('gemini_api_key', apiKey);
        localStorage.setItem('gemini_model_id', modelId);

        if (genConfig.screensaverType !== undefined) localStorage.setItem('app_screensaver_type', genConfig.screensaverType);

        if (genConfig.currency !== undefined) localStorage.setItem('app_currency', genConfig.currency);
        if (genConfig.enableConversion !== undefined) localStorage.setItem('app_enable_conversion', genConfig.enableConversion.toString());
        if (genConfig.outputLanguage !== undefined) localStorage.setItem('gemini_output_language', genConfig.outputLanguage);
        if (genConfig.idleOnBlur !== undefined) localStorage.setItem('app_idle_on_blur', genConfig.idleOnBlur.toString());
        if (genConfig.thinkingLevelStory !== undefined) localStorage.setItem('gemini_thinking_level_story', genConfig.thinkingLevelStory);
        if (genConfig.thinkingLevelGeneral !== undefined) localStorage.setItem('gemini_thinking_level_general', genConfig.thinkingLevelGeneral);

        if (genConfig.smartContextTurns !== undefined) {
            localStorage.setItem('gemini_smart_context_turns', genConfig.smartContextTurns.toString());
        }

        if (genConfig.exchangeRate !== undefined) localStorage.setItem('gemini_exchange_rate', genConfig.exchangeRate.toString());

        if (genConfig.fontSize !== undefined) localStorage.setItem('app_font_size', genConfig.fontSize.toString());
        else localStorage.removeItem('app_font_size');

        if (genConfig.fontFamily !== undefined) localStorage.setItem('app_font_family', genConfig.fontFamily);
        else localStorage.removeItem('app_font_family');

        if (genConfig.enableCache !== undefined) localStorage.setItem('gemini_enable_cache', genConfig.enableCache.toString());
        else localStorage.removeItem('gemini_enable_cache');

        const fullConfig: GameEngineConfig = { apiKey, modelId, ...genConfig };
        this.state.config.set(fullConfig);

        this.provider?.init({
            apiKey,
            modelId,
            ...genConfig
        });

        // Persist to IndexedDB for other services (e.g. Google Drive) to access
        this.storage.set('settings', fullConfig);

        // If language changed, we need to re-process system files for the UI
        if (genConfig.outputLanguage) {
            this.session.loadFiles(false);
            this.injection.loadDynamicInjectionSettings();
        }
    }

    /**
     * Imports configuration from a plain object (e.g. from JSON).
     */
    importConfig(config: unknown) {
        if (!config || typeof config !== 'object') {
            console.error('[ConfigService] Invalid config object provided for import');
            return;
        }
        const cfg = config as GameEngineConfig;

        // Validate essential fields or just apply what we can
        const apiKey = cfg.apiKey || '';
        const modelId = cfg.modelId || this.provider?.getDefaultModelId() || 'gemini-prod';

        // Construct the full config object, ensuring sections
        const genConfig = {
            fontSize: typeof cfg.fontSize === 'number' ? cfg.fontSize : undefined,
            fontFamily: typeof cfg.fontFamily === 'string' ? cfg.fontFamily : undefined,
            enableCache: typeof cfg.enableCache === 'boolean' ? cfg.enableCache : undefined,
            exchangeRate: typeof cfg.exchangeRate === 'number' ? cfg.exchangeRate : undefined,
            currency: typeof cfg.currency === 'string' ? cfg.currency : undefined,
            enableConversion: typeof cfg.enableConversion === 'boolean' ? cfg.enableConversion : undefined,
            screensaverType: (cfg.screensaverType === 'invaders' || cfg.screensaverType === 'code') ? cfg.screensaverType : undefined,
            outputLanguage: typeof cfg.outputLanguage === 'string' ? cfg.outputLanguage : undefined,
            idleOnBlur: typeof cfg.idleOnBlur === 'boolean' ? cfg.idleOnBlur : undefined,
            thinkingLevelStory: typeof cfg.thinkingLevelStory === 'string' ? cfg.thinkingLevelStory : undefined,
            thinkingLevelGeneral: typeof cfg.thinkingLevelGeneral === 'string' ? cfg.thinkingLevelGeneral : undefined,
            smartContextTurns: typeof cfg.smartContextTurns === 'number' ? cfg.smartContextTurns : undefined
        };

        // Reuse saveConfig to handle persistence (localStorage + Signal update + Service re-init)
        this.saveConfig(apiKey, modelId, genConfig);
        console.log('[ConfigService] Configuration imported successfully.');
    }
}
