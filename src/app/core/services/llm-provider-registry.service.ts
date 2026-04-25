import { Injectable, inject, computed, signal, effect } from '@angular/core';
import { LLMProvider, LLMProviderCapabilities, LLMProviderConfig, LLMModelDefinition } from '@hcs/llm-core';
import { LLMConfigService } from './llm-config.service';

/**
 * LLMProviderRegistryService
 *
 * Angular-facing wrapper over the stateless monorepo providers. The
 * "active provider" is derived from the active profile held by
 * LLMConfigService — this service holds zero config state of its own.
 * Its job is just:
 *   - keep the map of provider-name → provider-instance
 *   - expose `activeProvider()` / `getActiveConfig()` shortcuts
 *   - cache model lists sync-accessibly for cost displays (the monorepo's
 *     getAvailableModels is allowed to be async).
 */
@Injectable({ providedIn: 'root' })
export class LLMProviderRegistryService {
    private configService = inject(LLMConfigService);
    private providers = new Map<string, LLMProvider>();
    /**
     * Bumped on every register() so signal consumers re-evaluate after
     * providers land in the Map. Without this, `activeProvider` (a
     * computed) only reacts to activeProviderName changes — meaning if
     * any template reads `isConfigured` before LLMProviderInitService
     * finishes registering, the computed caches `null` and stays null
     * until the user manually toggles the profile dropdown. That's the
     * "Setup Required" mask that won't go away on first load.
     */
    private readonly _providersVersion = signal(0);

    readonly activeProviderName = this.configService.activeProviderName;
    readonly activeProvider = computed<LLMProvider | null>(() => {
        this._providersVersion(); // tracked so newly-registered providers are visible
        return this.providers.get(this.activeProviderName()) ?? null;
    });
    readonly hasActiveProvider = computed(() => this.activeProvider() !== null);

    /** Cached models keyed by provider name; populated via refreshActiveModels. */
    private modelCache = new Map<string, LLMModelDefinition[]>();
    private readonly _modelCacheVersion = signal(0);

    constructor() {
        // Whenever the active provider (or its backing profile's config) changes,
        // refresh the sync model cache so cost displays pick up new pricing.
        effect(() => {
            // Re-run whenever the profile swap changes provider name OR when
            // the active profile's settings change (e.g. model renamed).
            this.configService.activeProfile();
            const name = this.activeProviderName();
            if (!name) return;
            void this.refreshActiveModels();
        });
    }

    register(provider: LLMProvider): void {
        if (this.providers.has(provider.providerName)) {
            console.warn(`[LLMRegistry] Provider '${provider.providerName}' already registered; replacing.`);
        }
        this.providers.set(provider.providerName, provider);
        this._providersVersion.update(v => v + 1);
        console.log(`[LLMRegistry] Registered provider: ${provider.providerName}`);
    }

    /** Switch which profile is active (not which provider directly). */
    setActiveProfile(profileId: string): void {
        this.configService.setActiveProfileId(profileId);
    }

    getActive(): LLMProvider | null {
        return this.activeProvider();
    }

    getActiveConfig(): LLMProviderConfig {
        return this.configService.getActiveConfig();
    }

    getActiveBundle(): { provider: LLMProvider; config: LLMProviderConfig } | null {
        const provider = this.activeProvider();
        if (!provider) return null;
        return { provider, config: this.configService.getActiveConfig() };
    }

    getProvider(providerName: string): LLMProvider | undefined {
        return this.providers.get(providerName);
    }

    getCapabilities(): LLMProviderCapabilities {
        const provider = this.activeProvider();
        if (provider) return provider.getCapabilities();
        return {
            supportsContextCaching: false,
            supportsThinking: false,
            supportsStructuredOutput: false,
            isLocalProvider: false,
            supportsSpeedMetrics: false
        };
    }

    listProviders(): string[] {
        return Array.from(this.providers.keys());
    }

    hasProvider(providerName: string): boolean {
        return this.providers.has(providerName);
    }

    /** Sync accessor — whatever's in cache for the active provider. */
    getActiveModels(): LLMModelDefinition[] {
        this._modelCacheVersion();
        return this.modelCache.get(this.activeProviderName()) ?? [];
    }

    async refreshActiveModels(): Promise<LLMModelDefinition[]> {
        const name = this.activeProviderName();
        const provider = this.providers.get(name);
        if (!provider) return [];
        try {
            const result = await provider.getAvailableModels(this.configService.getActiveConfig());
            this.modelCache.set(name, result);
            this._modelCacheVersion.update(v => v + 1);
            return result;
        } catch (e) {
            console.warn(`[LLMRegistry] refreshActiveModels failed for ${name}:`, e);
            return this.modelCache.get(name) ?? [];
        }
    }

    invalidateModelCache(providerName?: string): void {
        if (providerName) {
            this.modelCache.delete(providerName);
        } else {
            this.modelCache.clear();
        }
        this._modelCacheVersion.update(v => v + 1);
    }
}
