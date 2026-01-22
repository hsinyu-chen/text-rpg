import { Injectable, signal, computed } from '@angular/core';
import { LLMProvider, LLMProviderCapabilities } from './llm-provider';

/**
 * LLM Provider Registry Service
 *
 * Factory pattern for managing and switching between LLM providers.
 * Maintains a registry of available providers and tracks the active one.
 */
@Injectable({
    providedIn: 'root'
})
export class LLMProviderRegistryService {
    /** Map of registered providers by name */
    private providers = new Map<string, LLMProvider>();

    /** Currently active provider */
    private _activeProvider = signal<LLMProvider | null>(null);

    /** Public readonly access to active provider */
    readonly activeProvider = this._activeProvider.asReadonly();

    /** Computed flag indicating if a provider is active */
    readonly hasActiveProvider = computed(() => this._activeProvider() !== null);

    /**
     * Register a provider with the registry.
     * @param provider The LLM provider instance to register
     */
    register(provider: LLMProvider): void {
        if (this.providers.has(provider.providerName)) {
            console.warn(`[LLMRegistry] Provider '${provider.providerName}' is already registered. Replacing.`);
        }
        this.providers.set(provider.providerName, provider);
        console.log(`[LLMRegistry] Registered provider: ${provider.providerName}`);
    }

    /**
     * Set the active provider by name.
     * @param providerName The name of the provider to activate
     * @throws Error if provider is not registered
     */
    setActive(providerName: string): void {
        const provider = this.providers.get(providerName);
        if (!provider) {
            const available = Array.from(this.providers.keys()).join(', ');
            throw new Error(`[LLMRegistry] Provider '${providerName}' not found. Available: ${available}`);
        }
        this._activeProvider.set(provider);
        console.log(`[LLMRegistry] Active provider set to: ${providerName}`);
    }

    /**
     * Get the currently active provider.
     * @returns The active provider or null if none is set
     */
    getActive(): LLMProvider | null {
        return this._activeProvider();
    }

    /**
     * Get a specific provider by name (without activating it).
     * @param providerName The name of the provider to retrieve
     * @returns The provider or undefined if not found
     */
    getProvider(providerName: string): LLMProvider | undefined {
        return this.providers.get(providerName);
    }

    /**
     * Get capability flags for the active provider.
     * @returns Capabilities object or a default "no capabilities" object if no provider is active
     */
    getCapabilities(): LLMProviderCapabilities {
        const provider = this._activeProvider();
        if (provider) {
            return provider.getCapabilities();
        }
        // Default: no capabilities
        return {
            supportsContextCaching: false,
            supportsThinking: false,
            supportsStructuredOutput: false,
            isLocalProvider: false
        };
    }

    /**
     * List all registered provider names.
     * @returns Array of provider names
     */
    listProviders(): string[] {
        return Array.from(this.providers.keys());
    }

    /**
     * Check if a specific provider is registered.
     * @param providerName The name to check
     * @returns True if registered
     */
    hasProvider(providerName: string): boolean {
        return this.providers.has(providerName);
    }
}
