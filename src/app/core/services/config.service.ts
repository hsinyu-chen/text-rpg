import { Injectable, RendererFactory2, RendererStyleFlags2, effect, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { GameStateService } from './game-state.service';
import { SessionService } from './session.service';
import { InjectionService } from './injection.service';
import { PromptProfileRegistryService } from './prompt-profile-registry.service';
import { DEFAULT_PROFILE_ID } from '../constants/prompt-profiles';
import { CostService } from './cost.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMConfigService } from './llm-config.service';
import { ActiveProfileStore } from './active-profile-store';
import { AppConfigStore, AppConfigShape } from './app-config-store';
import { isValidInterfaceLanguage } from '../i18n/ui-locales';

@Injectable({
    providedIn: 'root'
})
export class ConfigService {
    private state = inject(GameStateService);
    private session = inject(SessionService);
    private injection = inject(InjectionService);
    private profileRegistry = inject(PromptProfileRegistryService);
    private cost = inject(CostService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private llmConfig = inject(LLMConfigService);
    private activeProfileStore = inject(ActiveProfileStore);
    private appConfig = inject(AppConfigStore);
    private readonly doc = inject(DOCUMENT);
    private readonly renderer = inject(RendererFactory2).createRenderer(null, null);

    constructor() {
        // ==================== Auto-save Effects ====================

        // Sync CSS Variables with Config. Reads both font signals in one
        // effect — setStyle is idempotent, so re-applying the unchanged
        // value when its sibling fires is a no-op. Falsy → removeStyle so a
        // user clearing the override actually reverts to the stylesheet
        // default instead of stranding the last value on body.
        effect(() => {
            const fs = this.appConfig.fontSize();
            const ff = this.appConfig.fontFamily();
            if (fs) {
                this.renderer.setStyle(this.doc.body, '--app-font-size', `${fs}px`, RendererStyleFlags2.DashCase);
            } else {
                this.renderer.removeStyle(this.doc.body, '--app-font-size', RendererStyleFlags2.DashCase);
            }
            if (ff) {
                this.renderer.setStyle(this.doc.body, '--app-font-family', ff, RendererStyleFlags2.DashCase);
            } else {
                this.renderer.removeStyle(this.doc.body, '--app-font-family', RendererStyleFlags2.DashCase);
            }
        });
    }

    /**
     * Bootstraps the runtime concerns ConfigService still owns: exchange-rate
     * fetch, prompt-profile registry, and self-healing the active-profile
     * pointer if the referenced profile no longer exists. The app_* values
     * themselves are loaded eagerly by AppConfigStore on first inject.
     * Call this AFTER LLM providers are registered.
     */
    public async init() {
        void this.updateExchangeRateFromApi();

        // Registry must finish before injection load — the active id may resolve to a user profile from IDB.
        await this.profileRegistry.init();

        // Cross-tab deletion can leave the active id pointing at a profile we no longer know about.
        const activeId = this.state.activePromptProfile();
        if (!this.profileRegistry.get(activeId)) {
            console.warn(`[ConfigService] Active prompt profile '${activeId}' no longer exists — falling back to default.`);
            this.activeProfileStore.set(DEFAULT_PROFILE_ID);
        }

        // Initialize Injection Settings (History is loaded by session.init() → loadBook())
        await this.injection.loadDynamicInjectionSettings();

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
     * Triggers the FX API fetch. CostService writes the result back into
     * AppConfigStore directly; nothing for ConfigService to do beyond the
     * await.
     */
    private async updateExchangeRateFromApi() {
        await this.cost.updateExchangeRateFromApi();
    }

    /**
     * Persists a partial config update. AppConfigStore.patch is the source of
     * truth (localStorage + signals in lock-step); other services read live
     * from there, so no IDB mirror is required.
     */
    async saveConfig(genConfig: Partial<AppConfigShape>) {
        this.appConfig.patch(genConfig);

        // If language changed, re-process system files for the UI.
        // bumpTimestamp=false: language is a UI concern, not a KB content
        // change, so sync should not treat it as a reason to re-upload the book.
        if (genConfig.outputLanguage !== undefined) {
            await this.session.loadFiles(false, false);
            await this.injection.loadDynamicInjectionSettings();
        }
    }

    /**
     * Imports configuration from a plain object (e.g. from JSON).
     */
    async importConfig(config: unknown) {
        if (!config || typeof config !== 'object') {
            console.error('[ConfigService] Invalid config object provided for import');
            return;
        }
        // Permissive shape — pre-refactor exports may carry apiKey / modelId /
        // enableCache / thinkingLevels at the top level. We accept those for
        // backward compat and route them to the active LLM profile instead of
        // AppConfigStore.
        const cfg = config as Partial<AppConfigShape> & {
            apiKey?: string;
            modelId?: string;
            enableCache?: boolean;
            thinkingLevelStory?: string;
            thinkingLevelGeneral?: string;
        };

        // Build the partial only from valid-typed fields. Undefined keys are
        // omitted entirely so AppConfigStore.patch's "only-set-defined" contract
        // doesn't see explicit-undefined shadows.
        const genConfig: Partial<AppConfigShape> = {};
        if (typeof cfg.fontSize === 'number') genConfig.fontSize = cfg.fontSize;
        if (typeof cfg.fontFamily === 'string') genConfig.fontFamily = cfg.fontFamily;
        if (typeof cfg.exchangeRate === 'number') genConfig.exchangeRate = cfg.exchangeRate;
        if (typeof cfg.currency === 'string') genConfig.currency = cfg.currency;
        if (typeof cfg.enableConversion === 'boolean') genConfig.enableConversion = cfg.enableConversion;
        if (cfg.screensaverType === 'invaders' || cfg.screensaverType === 'code') genConfig.screensaverType = cfg.screensaverType;
        if (typeof cfg.outputLanguage === 'string') genConfig.outputLanguage = cfg.outputLanguage;
        if (isValidInterfaceLanguage(cfg.interfaceLanguage)) {
            genConfig.interfaceLanguage = cfg.interfaceLanguage;
        }
        if (typeof cfg.idleOnBlur === 'boolean') genConfig.idleOnBlur = cfg.idleOnBlur;
        if (typeof cfg.enableAdultDeclaration === 'boolean') genConfig.enableAdultDeclaration = cfg.enableAdultDeclaration;
        if (typeof cfg.smartContextTurns === 'number') genConfig.smartContextTurns = cfg.smartContextTurns;
        if (cfg.engineMode === 'single' || cfg.engineMode === 'two-call') genConfig.engineMode = cfg.engineMode;

        await this.saveConfig(genConfig);

        // Provider-bound fields go to the active LLM profile, not AppConfigStore.
        // Trigger if any of the LLM-side fields are present, so a JSON that carries
        // only enableCache / thinking levels still applies to the profile. Use
        // `!== undefined` rather than truthiness so an explicit empty string in
        // the import can intentionally clear an existing apiKey / modelId override.
        const hasProviderFields = cfg.apiKey !== undefined || cfg.modelId !== undefined
            || typeof cfg.enableCache === 'boolean'
            || cfg.thinkingLevelStory !== undefined || cfg.thinkingLevelGeneral !== undefined;
        if (hasProviderFields) {
            const existing = this.llmConfig.getActiveConfig();
            const merged = {
                ...existing,
                apiKey: cfg.apiKey ?? existing.apiKey,
                modelId: cfg.modelId ?? existing.modelId,
                additionalSettings: {
                    ...(existing.additionalSettings || {}),
                    ...(typeof cfg.enableCache === 'boolean' ? { enableCache: cfg.enableCache } : {}),
                    ...(cfg.thinkingLevelStory !== undefined ? { thinkingLevelStory: cfg.thinkingLevelStory } : {}),
                    ...(cfg.thinkingLevelGeneral !== undefined ? { thinkingLevelGeneral: cfg.thinkingLevelGeneral } : {})
                }
            };
            await this.llmConfig.saveActiveConfig(merged);
        }
        console.log('[ConfigService] Configuration imported successfully.');
    }
}
