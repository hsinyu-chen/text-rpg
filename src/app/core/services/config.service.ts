import { Injectable, RendererFactory2, RendererStyleFlags2, effect, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { GameStateService, GameEngineConfig } from './game-state.service';
import { StorageService } from './storage.service';
import { SessionService } from './session.service';
import { CacheManagerService } from './cache-manager.service';
import { InjectionService } from './injection.service';
import { PromptProfileRegistryService } from './prompt-profile-registry.service';
import { DEFAULT_PROFILE_ID } from '../constants/prompt-profiles';
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
    private profileRegistry = inject(PromptProfileRegistryService);
    private cost = inject(CostService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private llmConfig = inject(LLMConfigService);
    private readonly doc = inject(DOCUMENT);
    private readonly renderer = inject(RendererFactory2).createRenderer(null, null);

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
        this.updateExchangeRateFromApi();

        // Registry must finish before injection load — the active id may resolve to a user profile from IDB.
        await this.profileRegistry.init();

        // Cross-tab deletion can leave the active id pointing at a profile we no longer know about.
        const activeId = this.state.activePromptProfile();
        if (!this.profileRegistry.get(activeId)) {
            console.warn(`[ConfigService] Active prompt profile '${activeId}' no longer exists — falling back to default.`);
            this.state.activePromptProfile.set(DEFAULT_PROFILE_ID);
            localStorage.setItem('app_active_prompt_profile', DEFAULT_PROFILE_ID);
        }

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
        // Sanitize on read — localStorage can hold any string (corruption /
        // manual edit). Anything other than the known opt-in falls back to single.
        const engineMode: 'single' | 'two-call' = localStorage.getItem('app_engine_mode') === 'two-call' ? 'two-call' : 'single';

        const cfg: GameEngineConfig = {
            fontSize,
            fontFamily,
            exchangeRate: parseFloat(localStorage.getItem('app_exchange_rate') || localStorage.getItem('gemini_exchange_rate') || '30'),
            currency,
            enableConversion,
            screensaverType,
            outputLanguage: localStorage.getItem('app_output_language') || localStorage.getItem('gemini_output_language') || 'default',
            idleOnBlur,
            enableAdultDeclaration,
            smartContextTurns: parseInt(localStorage.getItem('app_smart_context_turns') || localStorage.getItem('gemini_smart_context_turns') || '10', 10),
            engineMode
        };

        this.state.config.set(cfg);

        // Monorepo providers are stateless — no provider.init() to call.
        // Populate the sync model cache for cost displays.
        void this.providerRegistry.refreshActiveModels();

        // KB token recompute is sequenced AFTER session.init() in app.component
        // so it doesn't race loadBook's clearFiles + saveFile loop. Doing it
        // here fire-and-forget would let loadFiles read a half-populated
        // file_store, set state.loadedFiles to an incomplete map, and then
        // saveCurrentSessionToBook would persist the truncated set back into
        // books_store — losing files on every reload.
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
        exchangeRate?: number,
        currency?: string,
        enableConversion?: boolean,
        screensaverType?: 'invaders' | 'code',
        outputLanguage?: string,
        idleOnBlur?: boolean,
        enableAdultDeclaration?: boolean,
        smartContextTurns?: number,
        engineMode?: 'single' | 'two-call'
    }) {
        if (genConfig.screensaverType !== undefined) localStorage.setItem('app_screensaver_type', genConfig.screensaverType);

        if (genConfig.currency !== undefined) localStorage.setItem('app_currency', genConfig.currency);
        if (genConfig.enableConversion !== undefined) localStorage.setItem('app_enable_conversion', genConfig.enableConversion.toString());
        if (genConfig.outputLanguage !== undefined) localStorage.setItem('app_output_language', genConfig.outputLanguage);
        if (genConfig.idleOnBlur !== undefined) localStorage.setItem('app_idle_on_blur', genConfig.idleOnBlur.toString());
        if (genConfig.enableAdultDeclaration !== undefined) localStorage.setItem('app_enable_adult_declaration', genConfig.enableAdultDeclaration.toString());
        if (genConfig.engineMode !== undefined) localStorage.setItem('app_engine_mode', genConfig.engineMode);

        if (genConfig.smartContextTurns !== undefined) {
            localStorage.setItem('app_smart_context_turns', genConfig.smartContextTurns.toString());
        }

        if (genConfig.exchangeRate !== undefined) localStorage.setItem('app_exchange_rate', genConfig.exchangeRate.toString());

        // Match the every-other-field pattern: only persist when the caller
        // actually supplied the field. Earlier `else removeItem` branches
        // here were wiping font settings on every partial update (e.g. the
        // chat-input's engineMode toggle).
        if (genConfig.fontSize !== undefined) localStorage.setItem('app_font_size', genConfig.fontSize.toString());
        if (genConfig.fontFamily !== undefined) localStorage.setItem('app_font_family', genConfig.fontFamily);

        // Spread current first so partial-update callers (e.g. the chat-input's
        // `saveConfig({ engineMode })`) don't wipe unrelated fields. Filter
        // explicit-undefineds out of genConfig because importConfig builds it
        // with `undefined` for missing fields, which would otherwise shadow
        // current via spread.
        const current = this.state.config();
        if (!current) {
            // Refuse to persist if init() hasn't seeded yet — otherwise a
            // pre-init saveConfig (e.g. importConfig fired from a deep link)
            // would write a truncated GameEngineConfig into IDB, dropping
            // unrelated fields the user had previously persisted.
            console.warn('[ConfigService] saveConfig called before init() seeded state.config — ignoring.');
            return;
        }
        const overrides = Object.fromEntries(
            Object.entries(genConfig).filter(([, v]) => v !== undefined)
        );
        const fullConfig: GameEngineConfig = {
            ...current,
            ...overrides
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
        // Permissive shape — pre-refactor exports may carry apiKey / modelId /
        // enableCache / thinkingLevels at the top level. We accept those for
        // backward compat and route them to the active LLM profile instead of
        // GameEngineConfig.
        const cfg = config as GameEngineConfig & {
            apiKey?: string;
            modelId?: string;
            enableCache?: boolean;
            thinkingLevelStory?: string;
            thinkingLevelGeneral?: string;
        };

        // Construct the full config object, ensuring sections
        const genConfig = {
            fontSize: typeof cfg.fontSize === 'number' ? cfg.fontSize : undefined,
            fontFamily: typeof cfg.fontFamily === 'string' ? cfg.fontFamily : undefined,
            exchangeRate: typeof cfg.exchangeRate === 'number' ? cfg.exchangeRate : undefined,
            currency: typeof cfg.currency === 'string' ? cfg.currency : undefined,
            enableConversion: typeof cfg.enableConversion === 'boolean' ? cfg.enableConversion : undefined,
            screensaverType: (cfg.screensaverType === 'invaders' || cfg.screensaverType === 'code') ? cfg.screensaverType : undefined,
            outputLanguage: typeof cfg.outputLanguage === 'string' ? cfg.outputLanguage : undefined,
            idleOnBlur: typeof cfg.idleOnBlur === 'boolean' ? cfg.idleOnBlur : undefined,
            enableAdultDeclaration: typeof cfg.enableAdultDeclaration === 'boolean' ? cfg.enableAdultDeclaration : undefined,
            smartContextTurns: typeof cfg.smartContextTurns === 'number' ? cfg.smartContextTurns : undefined,
            engineMode: (cfg.engineMode === 'single' || cfg.engineMode === 'two-call') ? cfg.engineMode : undefined
        };

        // Reuse saveConfig to handle persistence (localStorage + Signal update + Service re-init)
        this.saveConfig(genConfig);

        // Provider-bound fields go to the active LLM profile, not GameEngineConfig.
        // Trigger if any of the LLM-side fields are present, so a JSON that carries
        // only enableCache / thinking levels still applies to the profile.
        const hasProviderFields = !!cfg.apiKey || !!cfg.modelId
            || typeof cfg.enableCache === 'boolean'
            || !!cfg.thinkingLevelStory || !!cfg.thinkingLevelGeneral;
        if (hasProviderFields) {
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
