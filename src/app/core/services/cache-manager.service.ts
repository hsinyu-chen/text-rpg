import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMProvider, LLMProviderConfig, LLMCacheInfo } from '@hcs/llm-core';
import { CostService } from './cost.service';
import { KnowledgeService } from './knowledge.service';
import { ChatHistoryService } from './chat-history.service';

/**
 * Per-call input for {@link CacheManagerService.checkCacheAndRefresh}.
 *
 * Caller-resolved snapshot of `state.config()` / provider / files /
 * current cache metadata. Lets the method run without touching
 * `GameStateService` for these reads.
 */
export interface CacheCheckInput {
    provider: LLMProvider;
    providerConfig: LLMProviderConfig;
    enableCache: boolean;
    modelId: string;
    systemInstruction: string;
    loadedFiles: Map<string, string>;
    currentCacheName: string | null;
    currentCacheHash: string | null;
    currentCacheTokens: number;
    currentCacheExpireTime: number | null;
}

/**
 * Final cache state to commit. Caller writes the four signals
 * unconditionally (treat the returned values as the source of truth)
 * and then either starts or stops the storage timer based on whether
 * `cacheName` is non-null. If `sunkUsageTokens > 0`, caller should
 * record it via `chatHistory.recordSunkUsage`.
 */
export interface CacheCheckResult {
    cacheName: string | null;
    expireTime: number | null;
    hash: string | null;
    tokens: number;
    sunkUsageTokens: number;
}

/**
 * Service responsible for managing remote Cache and File lifecycle.
 * Handles validation, creation, refresh, and cleanup of server-side KB context.
 */
@Injectable({
    providedIn: 'root'
})
export class CacheManagerService {
    private state = inject(GameStateService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private cost = inject(CostService);
    private kb = inject(KnowledgeService);

    private chatHistory = inject(ChatHistoryService);

    /** Get the currently active LLM provider. */
    private get provider(): LLMProvider {
        const p = this.providerRegistry.getActive();
        if (!p) throw new Error('No active LLM provider');
        return p;
    }

    /** Config for the active provider — monorepo providers require it on every call. */
    private get providerConfig(): LLMProviderConfig {
        return this.providerRegistry.getActiveConfig();
    }

    // ==================== Timer Management ====================

    /**
     * Starts the storage cost timer for context caching.
     */
    startStorageTimer(): void {
        this.cost.updateContextState(
            this.state.kbCacheTokens(),
            this.state.kbCacheExpireTime(),
            this.state.config()?.modelId || this.provider.getDefaultModelId(),
            this.state.kbCacheName()
        );
        this.cost.startStorageTimer();
    }

    /**
     * Stops the storage cost timer.
     */
    stopStorageTimer(): void {
        this.cost.stopStorageTimer();
    }

    // ==================== Cache Validation & Refresh ====================

    /**
     * Validates if the current Knowledge Base (Cache or File) is still available on the server.
     * If not, attempts to restore it from local files (Self-healing).
     *
     * State mutation moved to caller. The returned `CacheCheckResult`
     * describes the FINAL desired cache state — caller writes the four
     * `state.kbCacheXxx` signals from it, records `sunkUsageTokens` into
     * chat-history if non-zero, and starts/stops the storage timer based
     * on whether `cacheName` is set.
     *
     * @throws Error with 'SESSION_EXPIRED' if context is lost and cannot be recovered.
     */
    async checkCacheAndRefresh(input: CacheCheckInput): Promise<CacheCheckResult> {
        const useCache = input.enableCache;
        const cacheName = input.currentCacheName;
        const hasLocalFiles = input.loadedFiles.size > 0;
        const ttlSeconds = 1800; // 30 minutes

        let validationSuccess = false;
        let resultCacheName: string | null = cacheName;
        let resultExpireTime: number | null = input.currentCacheExpireTime;
        let resultHash: string | null = input.currentCacheHash;
        let resultTokens = input.currentCacheTokens;
        let sunkUsageTokens = 0;

        // 1. Validate based on CURRENT MODE (Cache or File)
        if (useCache) {
            // [New] Hash Check for Staleness
            // Calculate current hash to ensure we're not using a stale cache
            const fileParts = this.kb.buildKnowledgeBaseParts(input.loadedFiles);
            const kbText = fileParts.map(p => p.text).join('');
            const currentHash = this.kb.calculateKbHash(kbText, input.modelId, input.systemInstruction);
            const storedHash = input.currentCacheHash;

            if (cacheName && input.provider.getCache) {
                console.log('[CacheManager] Validating remote cache:', cacheName);

                // Check Hash first
                if (storedHash && currentHash !== storedHash) {
                    console.log('[CacheManager] Cache hash mismatch (Stale). Deleting stale cache...');
                    // Server-side delete + cost-side acc transfer + timer stop happen
                    // in-place. State mutation (kbCacheXxx) is conveyed via the
                    // result instead — caller commits null/0 below if validation
                    // recovery doesn't overwrite them.
                    if (input.provider.deleteCache) {
                        await input.provider.deleteCache(input.providerConfig, cacheName);
                    }
                    const currentAcc = this.state.storageUsageAccumulated();
                    if (currentAcc > 0) {
                        this.state.historyStorageUsageAccumulated.update(v => v + currentAcc);
                        this.state.storageUsageAccumulated.set(0);
                    }
                    this.stopStorageTimer();
                    resultCacheName = null;
                    resultExpireTime = null;
                    resultHash = null;
                    resultTokens = 0;
                    validationSuccess = false; // Force rebuild
                } else {
                    const cacheStatus = await input.provider.getCache(input.providerConfig, cacheName);
                    if (cacheStatus) {
                        try {
                            let updated: LLMCacheInfo | null = null;
                            if (input.provider.updateCacheTTL) {
                                updated = await input.provider.updateCacheTTL(input.providerConfig, cacheName, ttlSeconds);
                            }

                            // If updated valid, or just exists (fall through)
                            if (updated?.expireTime) {
                                const expireMs = typeof updated.expireTime === 'number'
                                    ? updated.expireTime
                                    : new Date(updated.expireTime).getTime();
                                resultExpireTime = expireMs;
                                validationSuccess = true;

                                // Sync tokens from restored cache so UI shows current slot occupancy.
                                // Leave previous value if the provider didn't report new tokens.
                                const restoredTokens = cacheStatus.usageMetadata?.totalTokenCount || 0;
                                if (restoredTokens > 0) {
                                    resultTokens = restoredTokens;
                                }

                                console.log('[CacheManager] Cache validated and TTL extended.');
                            } else {
                                // If update failed but cache exists, we assume success but maybe no TTL extension
                                validationSuccess = true;
                                console.log('[CacheManager] Cache exists (TTL update skipped/failed).');
                            }
                        } catch (err) {
                            console.warn('[CacheManager] Cache TTL update failed, but cache exists.', err);
                            validationSuccess = true; // Still exists, so we can use it
                        }
                    } else {
                        // Proactive cleanup — cache gone server-side, nothing to delete remotely
                        resultCacheName = null;
                    }
                }
            }
        }

        // 2. If validation failed, try to recover
        if (!validationSuccess) {
            console.log('[CacheManager] KB context invalid or missing. Attempting recovery...');

            // Unified recovery logic
            if (hasLocalFiles) {
                console.log('[CacheManager] Re-creating Knowledge Base from local files...');
                const fileParts = this.kb.buildKnowledgeBaseParts(input.loadedFiles);
                const kbText = fileParts.map(p => p.text).join('');

                try {
                    if (useCache) {
                        const newHash = this.kb.calculateKbHash(kbText, input.modelId, input.systemInstruction);
                        let cacheRes: LLMCacheInfo | null = null;
                        if (input.provider.createCache) {
                            cacheRes = await input.provider.createCache(
                                input.providerConfig,
                                input.modelId || input.provider.getDefaultModelId(),
                                input.systemInstruction,
                                [{ role: 'user', parts: fileParts }],
                                ttlSeconds
                            );
                        }

                        if (cacheRes?.name) {
                            resultCacheName = cacheRes.name;
                            resultExpireTime = typeof cacheRes.expireTime === 'number'
                                ? cacheRes.expireTime
                                : Date.now() + ttlSeconds * 1000;
                            resultHash = newHash;
                            resultTokens = cacheRes.usageMetadata?.totalTokenCount || 0;

                            // Surface tokens for caller to record as sunk usage,
                            // ensuring persistent billing for the cache creation.
                            if (resultTokens > 0) {
                                sunkUsageTokens = resultTokens;
                                console.log('[CacheManager] Cache creation usage to be recorded:', resultTokens, 'tokens');
                            }

                            validationSuccess = true;
                            // Note: for providers that persist post-generation (e.g. llama.cpp slot save),
                            // this only means the reference is registered — the actual .bin write happens
                            // in the provider's generateContentStream finally block.
                            console.log('[CacheManager] Auto-cache reference registered:', cacheRes.name);
                        }
                    } else {
                        // If not using cache, local files are sufficient.
                        validationSuccess = true;
                        console.log('[CacheManager] Cache disabled. Using local files directly.');
                    }
                } catch (err) {
                    console.error('[CacheManager] Auto-cache creation failed:', err);
                }
            } else {
                if (!useCache) {
                    // Fallback when cache is disabled: No remote context, but treated as success to allow send (it will inject via System Prompt)
                    validationSuccess = true;
                }
            }
        }

        // 3. Final failure check
        if (!validationSuccess) {
            console.error('[CacheManager] KB context lost and cannot be recovered.');
            // Caller will see SESSION_EXPIRED and won't commit any result.
            // Caller is responsible for setting kbCacheName=null on this path.
            throw new Error('SESSION_EXPIRED');
        }

        // 4. Proactive cleanup of "leftover" resources from the OTHER mode
        // If we reached here, validationSuccess is true for the CURRENT mode.
        try {
            if (!useCache && cacheName) {
                // We are in No-Cache/Implicit mode. If there's a leftover Cache, clean it up to save costs.
                console.log('[CacheManager] Cleaning up leftover Cache while in Implicit mode.');
                if (input.provider.deleteCache) {
                    await input.provider.deleteCache(input.providerConfig, cacheName);
                }
                resultCacheName = null;
                resultExpireTime = null;
                resultHash = null;
                resultTokens = 0;
                this.stopStorageTimer();
            }
        } catch (cleanupErr) {
            console.warn('[CacheManager] Non-critical cleanup error during mode switch:', cleanupErr);
        }

        return {
            cacheName: resultCacheName,
            expireTime: resultExpireTime,
            hash: resultHash,
            tokens: resultTokens,
            sunkUsageTokens
        };
    }

    // ==================== Cache Cleanup ====================

    /**
     * Cleans up the active context cache on the server and resets local cache-related signals.
     */
    async cleanupCache(): Promise<void> {
        if (this.state.kbCacheName()) {
            console.log('[CacheManager] Cleaning up cache:', this.state.kbCacheName());

            // Before clearing, add the current session's storage usage to history
            const currentAcc = this.state.storageUsageAccumulated();
            if (currentAcc > 0) {
                this.state.historyStorageUsageAccumulated.update(v => v + currentAcc);
                this.state.storageUsageAccumulated.set(0);
            }

            if (this.provider.deleteCache) {
                await this.provider.deleteCache(this.providerConfig, this.state.kbCacheName()!);
            }
            this.state.kbCacheName.set(null);
            this.state.kbCacheExpireTime.set(null);
            this.state.kbCacheHash.set(null);
            this.state.kbCacheTokens.set(0);
            this.stopStorageTimer();
        }
    }

    /**
     * Clears all server-side caches and uploaded files, and resets the local session state.
     * @returns The number of caches deleted.
     */
    async clearAllServerCaches(): Promise<number> {
        this.state.status.set('loading');
        try {
            console.log('[CacheManager] Clearing ALL server-side caches and files...');
            let count = 0;
            if (this.provider.deleteAllCaches) {
                count = await this.provider.deleteAllCaches(this.providerConfig);
            }

            // Transfer Active Usage to History (Preserving costs)
            const currentAcc = this.state.storageUsageAccumulated();
            if (currentAcc > 0) {
                this.state.historyStorageUsageAccumulated.update(v => v + currentAcc);
            }

            // Reset active cache signals
            this.state.kbCacheName.set(null);
            this.state.kbCacheExpireTime.set(null);
            this.state.kbCacheHash.set(null);
            this.state.storageUsageAccumulated.set(0);
            this.state.kbCacheTokens.set(0);
            this.stopStorageTimer();

            // One-time cleanup of legacy localStorage keys
            localStorage.removeItem('storage_cost_acc');
            localStorage.removeItem('history_storage_cost_acc');
            localStorage.removeItem('estimated_cost');
            localStorage.removeItem('usage_stats');

            this.state.status.set('idle');
            return count;
        } catch (e) {
            console.error('[CacheManager] Failed to clear all server data:', e);
            this.state.status.set('error');
            return 0;
        }
    }

    /**
     * Manually releases the active context cache on the server while preserving chat history.
     */
    async releaseCache(): Promise<void> {
        const cacheName = this.state.kbCacheName();
        if (cacheName) {
            console.log('[CacheManager] Manually releasing cache:', cacheName);
            try {
                // Add current to history before release
                const currentAcc = this.state.storageUsageAccumulated();
                if (currentAcc > 0) {
                    this.state.historyStorageUsageAccumulated.update(v => v + currentAcc);
                }

                if (this.provider.deleteCache) {
                    await this.provider.deleteCache(this.providerConfig, cacheName);
                }
            } catch (err) {
                console.error('[CacheManager] Failed to delete cache from server:', err);
            }
        }

        // Clear local state
        this.state.kbCacheName.set(null);
        this.state.kbCacheExpireTime.set(null);
        this.state.kbCacheHash.set(null);
        this.state.storageUsageAccumulated.set(0);
        this.state.kbCacheTokens.set(0);
        this.stopStorageTimer();

        console.log('[CacheManager] Cache released successfully.');
    }

    /**
     * Resets all cache-related state without making server calls.
     * Used by wipeLocalSession to reset cache state after clearing storage.
     */
    resetCacheState(): void {
        this.state.kbCacheName.set(null);
        this.state.kbCacheExpireTime.set(null);
        this.state.kbCacheHash.set(null);
        this.state.kbCacheTokens.set(0);
        this.stopStorageTimer();
    }
}
