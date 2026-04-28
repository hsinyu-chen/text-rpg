import { Injectable, RendererFactory2, RendererStyleFlags2, effect, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { GameStateService, GameEngineConfig } from './game-state.service';
import { StorageService } from './storage.service';
import { SessionService } from './session.service';
import { CacheManagerService } from './cache-manager.service';
import { InjectionService } from './injection.service';
import { CostService } from './cost.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMConfigService } from './llm-config.service';

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
    private llmConfig = inject(LLMConfigService);
    private readonly doc = inject(DOCUMENT);
    private readonly renderer = inject(RendererFactory2).createRenderer(null, null);

    private get provider() {
        return this.providerRegistry.getActive();
    }

    /**
     * Extract TextRPG-specific fields (enableCache, thinkingLevelStory/General)
     * out of a provider config's additionalSettings bucket. Used to bridge the
     * monorepo's flat LLMProviderConfig shape into the GameEngineConfig shape.
     */
    private readProviderSettings(config: ReturnType<LLMConfigService['getActiveConfig']>) {
        const s = config.additionalSettings || {};
        return {
            enableCache: typeof s['enableCache'] === 'boolean' ? s['enableCache'] as boolean : undefined,
            thinkingLevelStory: typeof s['thinkingLevelStory'] === 'string' ? s['thinkingLevelStory'] as string : undefined,
            thinkingLevelGeneral: typeof s['thinkingLevelGeneral'] === 'string' ? s['thinkingLevelGeneral'] as string : undefined
        };
    }

    constructor() {
        // ==================== Auto-save Effects ====================

        // Sync CSS Variables with Config
        effect(() => {
            const cfg = this.state.config();
            if (!cfg) return;
            if (cfg.fontSize) {
                this.renderer.setStyle(this.doc.body, '--app-font-size', `${cfg.fontSize}px`, RendererStyleFlags2.DashCase);
            }
            if (cfg.fontFamily) {
                this.renderer.setStyle(this.doc.body, '--app-font-family', cfg.fontFamily, RendererStyleFlags2.DashCase);
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

        // Initialize Injection Settings (History is loaded by session.init() → loadBook())
        await this.injection.loadDynamicInjectionSettings();

        // Get Global UI settings
        const sSize = localStorage.getItem('app_font_size');
        const sFamily = localStorage.getItem('app_font_family');
        const fontSize = sSize ? parseInt(sSize, 10) : undefined;
        const fontFamily = sFamily || undefined;

        const screensaverType = (localStorage.getItem('app_screensaver_type') as 'invaders' | 'code') || 'invaders';
        const currency = localStorage.getItem('app_currency') || 'TWD';
        const enableConversion = localStorage.getItem('app_enable_conversion') === 'true';
        const idleOnBlur = localStorage.getItem('app_idle_on_blur') === 'true';
        const enableAdultDeclaration = localStorage.getItem('app_enable_adult_declaration') !== 'false';

        // Get Provider-Specific settings from the active provider's persisted config
        const activeProvider = this.providerRegistry.getActive();
        const providerConfig = this.llmConfig.getActiveConfig();
        const providerExtras = this.readProviderSettings(providerConfig);

        const cfg: GameEngineConfig = {
            apiKey: providerConfig.apiKey || '',
            modelId: providerConfig.modelId || activeProvider?.getDefaultModelId() || '',
            fontSize,
            fontFamily,
            enableCache: providerExtras.enableCache ?? (localStorage.getItem('app_enable_cache') === 'true'),
            exchangeRate: parseFloat(localStorage.getItem('app_exchange_rate') || localStorage.getItem('gemini_exchange_rate') || '30'),
            currency,
            enableConversion,
            screensaverType,
            outputLanguage: localStorage.getItem('app_output_language') || localStorage.getItem('gemini_output_language') || 'default',
            idleOnBlur,
            enableAdultDeclaration,
            thinkingLevelStory: providerExtras.thinkingLevelStory || 'minimal',
            thinkingLevelGeneral: providerExtras.thinkingLevelGeneral || 'high',
            smartContextTurns: parseInt(localStorage.getItem('app_smart_context_turns') || localStorage.getItem('gemini_smart_context_turns') || '10', 10)
        };

        this.state.config.set(cfg);

        // Monorepo providers are stateless — no provider.init() to call.
        // Populate the sync model cache for cost displays.
        void this.providerRegistry.refreshActiveModels();

        // Sync files from DB on startup
        this.session.loadFiles(false);
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
        enableAdultDeclaration?: boolean,
        thinkingLevelStory?: string,
        thinkingLevelGeneral?: string,
        smartContextTurns?: number
    }) {
        // API Key and Model ID handling is now provider-specific via saveConfig, 
        // but we still update the active config signal.

        if (genConfig.screensaverType !== undefined) localStorage.setItem('app_screensaver_type', genConfig.screensaverType);

        if (genConfig.currency !== undefined) localStorage.setItem('app_currency', genConfig.currency);
        if (genConfig.enableConversion !== undefined) localStorage.setItem('app_enable_conversion', genConfig.enableConversion.toString());
        if (genConfig.outputLanguage !== undefined) localStorage.setItem('app_output_language', genConfig.outputLanguage);
        if (genConfig.idleOnBlur !== undefined) localStorage.setItem('app_idle_on_blur', genConfig.idleOnBlur.toString());
        if (genConfig.enableAdultDeclaration !== undefined) localStorage.setItem('app_enable_adult_declaration', genConfig.enableAdultDeclaration.toString());

        // Caching and Thinking levels are mostly provider specific but can be toggled in global config if common
        if (genConfig.enableCache !== undefined) localStorage.setItem('app_enable_cache', genConfig.enableCache.toString());

        if (genConfig.smartContextTurns !== undefined) {
            localStorage.setItem('app_smart_context_turns', genConfig.smartContextTurns.toString());
        }

        if (genConfig.exchangeRate !== undefined) localStorage.setItem('app_exchange_rate', genConfig.exchangeRate.toString());

        if (genConfig.fontSize !== undefined) localStorage.setItem('app_font_size', genConfig.fontSize.toString());
        else localStorage.removeItem('app_font_size');

        if (genConfig.fontFamily !== undefined) localStorage.setItem('app_font_family', genConfig.fontFamily);
        else localStorage.removeItem('app_font_family');

        // Fetch current provider state for the signal
        const activeProvider = this.providerRegistry.getActive();
        const providerConfig = this.llmConfig.getActiveConfig();
        const providerExtras = this.readProviderSettings(providerConfig);

        const fullConfig: GameEngineConfig = {
            apiKey: providerConfig.apiKey || '',
            modelId: providerConfig.modelId || activeProvider?.getDefaultModelId() || '',
            ...genConfig,
            // enableCache is provider-specific and may not be in genConfig; pull from providerConfig
            // so toggling the setting takes effect immediately instead of requiring a reload.
            enableCache: genConfig.enableCache ?? providerExtras.enableCache ?? (localStorage.getItem('app_enable_cache') === 'true')
        };
        this.state.config.set(fullConfig);

        // Persist to IndexedDB for other services (e.g. Google Drive) to access
        this.storage.set('settings', fullConfig);

        // If language changed, we need to re-process system files for the UI.
        // Pass bumpTimestamp=false: language is a UI concern, not a KB content
        // change, so sync should not treat it as a reason to re-upload the book.
        if (genConfig.outputLanguage) {
            this.session.loadFiles(false, false);
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
            enableAdultDeclaration: typeof cfg.enableAdultDeclaration === 'boolean' ? cfg.enableAdultDeclaration : undefined,
            thinkingLevelStory: typeof cfg.thinkingLevelStory === 'string' ? cfg.thinkingLevelStory : undefined,
            thinkingLevelGeneral: typeof cfg.thinkingLevelGeneral === 'string' ? cfg.thinkingLevelGeneral : undefined,
            smartContextTurns: typeof cfg.smartContextTurns === 'number' ? cfg.smartContextTurns : undefined
        };

        // Reuse saveConfig to handle persistence (localStorage + Signal update + Service re-init)
        this.saveConfig(genConfig);

        // Also update the active provider's config if supplied
        if (cfg.apiKey || cfg.modelId) {
            const existing = this.llmConfig.getActiveConfig();
            const merged = {
                ...existing,
                apiKey: cfg.apiKey ?? existing.apiKey,
                modelId: cfg.modelId ?? existing.modelId,
                additionalSettings: {
                    ...(existing.additionalSettings || {}),
                    ...(typeof cfg.enableCache === 'boolean' ? { enableCache: cfg.enableCache } : {}),
                    ...(cfg.thinkingLevelStory ? { thinkingLevelStory: cfg.thinkingLevelStory } : {}),
                    ...(cfg.thinkingLevelGeneral ? { thinkingLevelGeneral: cfg.thinkingLevelGeneral } : {})
                }
            };
            this.llmConfig.saveActiveConfig(merged);
        }
        console.log('[ConfigService] Configuration imported successfully.');
    }
}
