import { Injectable, signal, inject } from '@angular/core';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMModelDefinition } from './llm-provider';
import { ChatMessage } from '../models/types';

@Injectable({
    providedIn: 'root'
})
export class CostService {
    private providerRegistry = inject(LLMProviderRegistryService);

    // Signals
    storageCostAccumulated = signal<number>(0);
    cacheCountdown = signal<string | null>(null);
    exchangeRate = signal<number>(32.5); // Default fallback

    // Internal state for cost calculation
    private contextState = signal<{
        tokens: number;
        expireTime: number | null;
        modelId: string;
        cacheName: string | null;
    } | null>(null);

    private storageTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        this.loadExchangeRate();
    }

    /**
     * Get model definition by ID from the active provider (or search all).
     */
    private getModelDefinition(modelId: string): LLMModelDefinition {
        // Try active provider first
        const active = this.providerRegistry.getActive();
        if (active) {
            const model = active.getAvailableModels().find(m => m.id === modelId);
            if (model) return model;
        }

        // Fallback: Use active provider's default or safe fallback
        if (active && active.getAvailableModels().length > 0) {
            return active.getAvailableModels()[0];
        }

        // Emergency fallback if no active provider or models
        return {
            id: 'unknown',
            name: 'Unknown Model',
            getRates: () => ({ input: 0, output: 0 })
        };
    }

    /**
     * Updates the context state used for cost and countdown calculations.
     */
    updateContextState(tokens: number, expireTime: number | null, modelId: string, cacheName: string | null) {
        this.contextState.set({ tokens, expireTime, modelId, cacheName });
        // Immediate update to UI
        this.updateCacheCountdown();
    }

    /**
     * Starts the timer that periodically updates the cache countdown and increments storage cost.
     */
    startStorageTimer() {
        this.stopStorageTimer();
        this.storageTimer = setInterval(() => {
            this.updateCacheCountdown();
            this.incrementStorageCost();
        }, 1000);
    }

    /**
     * Stops the storage cost timer.
     */
    stopStorageTimer() {
        if (this.storageTimer) {
            clearInterval(this.storageTimer);
            this.storageTimer = null;
        }
    }

    /**
     * Calculates the cost of creating or refreshing a context cache.
     * This is billed as standard input tokens.
     */
    calculateCacheCreationCost(tokens: number, modelId?: string): number {
        if (tokens <= 0) return 0;
        if (!modelId) {
            const active = this.providerRegistry.getActive();
            modelId = active ? active.getDefaultModelId() : 'unknown';
        }
        const rates = this.getModelDefinition(modelId).getRates(tokens);
        return (tokens / 1000000) * rates.input;
    }

    /**
     * Calculates the estimated cost of a single turn based on token usage.
     */
    calculateTurnCost(turnUsage: { prompt: number, candidates: number, cached: number }, modelId?: string) {
        if (!modelId) {
            const active = this.providerRegistry.getActive();
            modelId = active ? active.getDefaultModelId() : 'unknown';
        }
        const rates = this.getModelDefinition(modelId).getRates(turnUsage.prompt);

        // Robust calculation: prompt may be inclusive or exclusive of cached depending on SDK version
        const fresh = turnUsage.prompt >= turnUsage.cached
            ? turnUsage.prompt - turnUsage.cached
            : turnUsage.prompt;

        // Transaction costs: Fresh input + Output + Cache recall
        const cost = (fresh / 1000000 * rates.input) +
            (turnUsage.candidates / 1000000 * rates.output) +
            (turnUsage.cached / 1000000 * (rates.cached || 0));

        return cost;
    }

    /**
     * Calculates the remaining time before the context cache expires and updates the countdown signal.
     */
    private updateCacheCountdown() {
        const state = this.contextState();
        if (!state || !state.expireTime || !state.cacheName) {
            this.cacheCountdown.set(null);
            return;
        }

        const now = Date.now();
        const remaining = Math.max(0, Math.floor((state.expireTime - now) / 1000));

        if (remaining <= 0) {
            this.cacheCountdown.set('EXPIRED');
        } else {
            const m = Math.floor(remaining / 60);
            const s = remaining % 60;
            this.cacheCountdown.set(`${m}:${s.toString().padStart(2, '0')}`);
        }
    }

    /**
     * Calculates and adds the storage cost of the context cache to the accumulated cost.
     */
    private incrementStorageCost() {
        const state = this.contextState();
        if (!state || !state.expireTime) return;

        const modelId = state.modelId;
        const tokens = state.tokens;
        const now = Date.now();
        const expireTime = state.expireTime;

        if (tokens > 0 && expireTime && expireTime > now) {
            const rates = this.getModelDefinition(modelId).getRates(tokens);
            const hourlyRate = rates.cacheStorage || 0;
            const perSecondCost = (tokens / 1000000) * hourlyRate / 3600;
            this.storageCostAccumulated.update(v => v + perSecondCost);
        }
    }

    /**
     * Calculates the total transaction cost for a session by replaying each message against a specific model's pricing.
     * This ensures accurate costs even if the model was changed mid-session, or for hypothetical comparisons.
     */
    calculateSessionTransactionCost(messages: ChatMessage[], model: LLMModelDefinition): number {
        let totalCost = 0;
        for (const msg of messages) {
            if (msg.role === 'model' && msg.usage) {
                // Get rates for THIS specific turn's input size (handles tiered pricing)
                const rates = model.getRates(msg.usage.prompt);

                const fresh = msg.usage.prompt >= msg.usage.cached
                    ? msg.usage.prompt - msg.usage.cached
                    : msg.usage.prompt;

                const turnCost = (fresh / 1_000_000 * rates.input) +
                    (msg.usage.candidates / 1_000_000 * rates.output) +
                    (msg.usage.cached / 1_000_000 * (rates.cached || 0));

                totalCost += turnCost;
            }
        }
        return totalCost;
    }

    /**
     * Fetches the latest USD to TWD exchange rate from a free API.
     */
    async updateExchangeRateFromApi() {
        try {
            console.log('[CostService] Fetching latest USD/TWD exchange rate...');
            const response = await fetch('https://open.er-api.com/v6/latest/USD');
            if (response.ok) {
                const data = await response.json();
                const rate = data.rates?.TWD;
                if (rate) {
                    console.log('[CostService] FX Rate Updated:', rate);
                    this.exchangeRate.set(rate);
                    localStorage.setItem('gemini_exchange_rate', rate.toString());
                }
            } else {
                console.error('[CostService] FX API error response:', response.status, response.statusText);
            }
        } catch (err) {
            console.error('[CostService] Failed to fetch exchange rate:', err);
        }
    }

    private loadExchangeRate() {
        const stored = localStorage.getItem('gemini_exchange_rate');
        if (stored) {
            const rate = parseFloat(stored);
            if (!isNaN(rate)) {
                this.exchangeRate.set(rate);
            }
        }
    }
}
