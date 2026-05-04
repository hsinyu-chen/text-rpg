import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMProvider, LLMProviderConfig, LLMCacheInfo } from '@hcs/llm-core';
import { CostService } from './cost.service';
import { KnowledgeService } from './knowledge.service';
import type { LLMPart } from '@hcs/llm-core';

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
    /**
     * Pre-computed KB hash for the current state. Caller passes this from
     * `state.currentKbHash()` (a memoized computed signal), so the service
     * doesn't re-walk the file map to hash on every turn. Becomes the
     * stored hash on a fresh cache creation, so validation across turns
     * compares like-for-like.
     */
    targetHash: string;
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

    /** Get the currently active LLM provider. */
    private get provider(): LLMProvider {
        const p = this.providerRegistry.getActive();
        if (!p) throw new Error('No active LLM provider');
        return p;
    }

    /**
     * Retire the active cache's storage tracking: transfer the in-flight
     * accumulator into the historical tally, zero it, and stop the timer.
     * Called from every path that retires a cache — lifecycle methods
     * (cleanup/release/clearAll), the per-turn refresh's three null-out
     * branches (staleness, proactive, leftover), AND the session-expiry
     * reset. Stopping the timer inline (rather than at each callsite)
     * prevents the timer from continuing to bill against a now-dead cache
     * during the async recovery window in checkCacheAndRefresh.
     */
    private finalizeStorageUsage(): void {
        const currentAcc = this.state.storageUsageAccumulated();
        if (currentAcc > 0) {
            this.state.historyStorageUsageAccumulated.update(v => v + currentAcc);
            this.state.storageUsageAccumulated.set(0);
        }
        this.stopStorageTimer();
    }

    /**
     * Null the four kbCache* signals. Pairs with `finalizeStorageUsage` —
     * this clears the per-cache identity, that retires the per-cache
     * cost tracking. Lifecycle methods (cleanup/release/clearAll/reset)
     * call both. The per-turn refresh path doesn't — it conveys the
     * desired state via `CacheCheckResult` and lets the caller commit.
     */
    private clearLocalCacheSignals(): void {
        this.state.kbCacheName.set(null);
        this.state.kbCacheExpireTime.set(null);
        this.state.kbCacheHash.set(null);
        this.state.kbCacheTokens.set(0);
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
     * Stops the storage cost timer AND clears the context state so the
     * UI countdown disappears. Without the second call, cacheCountdown
     * would freeze on its last value (e.g. "29:42") because
     * updateCacheCountdown is only invoked from updateContextState or
     * the timer tick — and we just stopped both.
     */
    stopStorageTimer(): void {
        this.cost.stopStorageTimer();
        this.cost.updateContextState(0, null, 'unknown', null);
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
     * @param input Per-call snapshot — provider + config, current cache
     *   identity (name/hash/tokens/expireTime), targetHash for staleness
     *   detection, loaded files for restoration, and the system prompt
     *   the cache should bind to.
     * @throws Error with 'SESSION_EXPIRED' if context is lost and cannot be recovered.
     */
    async checkCacheAndRefresh(input: CacheCheckInput): Promise<CacheCheckResult> {
        const useCache = input.enableCache;
        const cacheName = input.currentCacheName;
        const hasLocalFiles = input.loadedFiles.size > 0;
        const ttlSeconds = 1800; // 30 minutes

        let validationSuccess = false;
        // When caching is off, the result starts cleared — no path below
        // resets these fields when !useCache && !cacheName, and we don't
        // want a previously-active cache's stale hash/tokens to ride
        // through and get re-committed by the caller.
        let resultCacheName: string | null = useCache ? cacheName : null;
        let resultExpireTime: number | null = useCache ? input.currentCacheExpireTime : null;
        let resultHash: string | null = useCache ? input.currentCacheHash : null;
        let resultTokens = useCache ? input.currentCacheTokens : 0;
        let sunkUsageTokens = 0;

        // Hash for staleness check + new-cache storage comes pre-computed
        // from caller (state.currentKbHash signal). Avoids walking the
        // file map on every turn for the validated-success path.
        const currentHash = input.targetHash;

        // KB parts only get built when recovery actually fires
        // (cache missing / stale / cache-disabled-mode-leftover doesn't
        // need them). Lazy-init below.
        let kbParts: LLMPart[] | null = null;

        // 1. Validate based on CURRENT MODE (Cache or File)
        if (useCache) {
            const storedHash = input.currentCacheHash;

            if (cacheName && input.provider.getCache) {
                console.log('[CacheManager] Validating remote cache:', cacheName);

                // Check Hash first
                if (currentHash !== storedHash) {
                    console.log('[CacheManager] Cache hash mismatch (Stale). Deleting stale cache...');
                    // Stop billing + clear the result first so we're committed
                    // to retiring this cache regardless of what the network
                    // does next. If deleteCache throws (network blip), recovery
                    // can still rebuild — losing one orphan server-side cache
                    // is far better than blocking the turn.
                    this.finalizeStorageUsage();
                    resultCacheName = null;
                    resultExpireTime = null;
                    resultHash = null;
                    resultTokens = 0;
                    validationSuccess = false; // Force rebuild
                    if (input.provider.deleteCache) {
                        try {
                            await input.provider.deleteCache(input.providerConfig, cacheName);
                        } catch (err) {
                            console.warn('[CacheManager] Failed to delete stale cache (continuing to recovery):', err);
                        }
                    }
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
                                // Guard: `new Date('garbage').getTime()` is NaN.
                                // Skip the assignment rather than poison
                                // kbCacheExpireTime — CostService treats NaN as
                                // "expired now", which would tank cost calc.
                                if (!isNaN(expireMs)) {
                                    resultExpireTime = expireMs;
                                }
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
                        // Proactive cleanup — cache gone server-side. Null
                        // all four so caller doesn't commit stale tokens /
                        // expireTime / hash from a now-defunct cache.
                        // Also retire the active storage accumulator —
                        // cost incurred while the cache was alive shouldn't
                        // vanish when the cache does.
                        this.finalizeStorageUsage();
                        resultCacheName = null;
                        resultExpireTime = null;
                        resultHash = null;
                        resultTokens = 0;
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

                try {
                    if (useCache) {
                        // Build kbParts on demand — this is the only branch
                        // that needs the parts shape (createCache contents).
                        // Validation path skips this entirely.
                        kbParts ??= this.kb.buildKnowledgeBaseParts(input.loadedFiles);
                        let cacheRes: LLMCacheInfo | null = null;
                        if (input.provider.createCache) {
                            cacheRes = await input.provider.createCache(
                                input.providerConfig,
                                input.modelId,
                                input.systemInstruction,
                                [{ role: 'user', parts: kbParts }],
                                ttlSeconds
                            );
                        }

                        if (cacheRes?.name) {
                            resultCacheName = cacheRes.name;
                            // Mirror the validation path's expireTime parsing.
                            // Guard against NaN from invalid ISO strings —
                            // CostService treats NaN as "expired now" and
                            // would mis-bill storage. Fall back to now+TTL
                            // for both "missing" and "unparseable" cases.
                            const rawExpire = cacheRes.expireTime;
                            const parsed = typeof rawExpire === 'number'
                                ? rawExpire
                                : (rawExpire ? new Date(rawExpire).getTime() : NaN);
                            resultExpireTime = isNaN(parsed)
                                ? (Date.now() + ttlSeconds * 1000)
                                : parsed;
                            resultHash = currentHash;
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
            // Caller catches and clears all four kbCache signals — see
            // game-engine.sendMessage's catch block.
            throw new Error('SESSION_EXPIRED');
        }

        // 4. Proactive cleanup of "leftover" resources from the OTHER mode
        // If we reached here, validationSuccess is true for the CURRENT mode.
        try {
            if (!useCache && cacheName) {
                // We are in No-Cache/Implicit mode. If there's a leftover Cache, clean it up to save costs.
                console.log('[CacheManager] Cleaning up leftover Cache while in Implicit mode.');
                // Stop billing before the async deleteCache round-trip.
                this.finalizeStorageUsage();
                if (input.provider.deleteCache) {
                    await input.provider.deleteCache(input.providerConfig, cacheName);
                }
                resultCacheName = null;
                resultExpireTime = null;
                resultHash = null;
                resultTokens = 0;
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

            this.finalizeStorageUsage();

            // Don't let a network blip on deleteCache leave local signals
            // pointing at a cache that's already been written off in cost.
            // Same pattern releaseCache uses below.
            try {
                if (this.provider.deleteCache) {
                    await this.provider.deleteCache(this.providerConfig, this.state.kbCacheName()!);
                }
            } catch (err) {
                console.error('[CacheManager] Failed to delete cache from server:', err);
            }
            this.clearLocalCacheSignals();
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

            // Match the resilience pattern used by cleanupCache/releaseCache:
            // local retirement happens regardless of network outcome so the
            // billing timer doesn't keep accruing against caches that may be
            // gone (or that we'll never reach again).
            this.finalizeStorageUsage();
            this.clearLocalCacheSignals();

            let count = 0;
            if (this.provider.deleteAllCaches) {
                try {
                    count = await this.provider.deleteAllCaches(this.providerConfig);
                } catch (err) {
                    console.error('[CacheManager] deleteAllCaches failed:', err);
                }
            }

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
                this.finalizeStorageUsage();

                if (this.provider.deleteCache) {
                    await this.provider.deleteCache(this.providerConfig, cacheName);
                }
            } catch (err) {
                console.error('[CacheManager] Failed to delete cache from server:', err);
            }
        }

        this.clearLocalCacheSignals();

        console.log('[CacheManager] Cache released successfully.');
    }

    /**
     * Resets all cache-related state without making server calls.
     * Used by wipeLocalSession to reset cache state after clearing storage.
     */
    resetCacheState(): void {
        this.finalizeStorageUsage();
        this.clearLocalCacheSignals();
    }
}
