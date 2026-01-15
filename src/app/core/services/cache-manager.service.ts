import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMProvider, LLMCacheInfo } from './llm-provider';
import { CostService } from './cost.service';
import { KnowledgeService } from './knowledge.service';
import { StorageService } from './storage.service';

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
    private storage = inject(StorageService);

    /** Get the currently active LLM provider */
    private get provider(): LLMProvider {
        const p = this.providerRegistry.getActive();
        if (!p) throw new Error('No active LLM provider');
        return p;
    }

    // ==================== Timer Management ====================

    /**
     * Starts the storage cost timer for context caching.
     */
    startStorageTimer(): void {
        this.cost.updateContextState(
            this.state.kbCacheTokens,
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
     * @param systemInstruction The current system instruction for cache creation.
     * @throws Error with 'SESSION_EXPIRED' if context is lost and cannot be recovered.
     */
    async checkCacheAndRefresh(systemInstruction: string): Promise<void> {
        const config = this.state.config();
        const useCache = !!config?.enableCache;
        const cacheName = this.state.kbCacheName();
        let fileUri = this.state.kbFileUri();
        const hasLocalFiles = this.state.loadedFiles().size > 0;
        const ttlSeconds = 1800; // 30 minutes

        let validationSuccess = false;

        // 1. Validate based on CURRENT MODE (Cache or File)
        if (useCache) {
            if (cacheName && this.provider.getCache) {
                console.log('[CacheManager] Validating remote cache:', cacheName);
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
                            this.state.kbCacheExpireTime.set(expireMs);
                            validationSuccess = true;
                            this.startStorageTimer();
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
                    // Proactive cleanup
                    this.state.kbCacheName.set(null);
                    localStorage.removeItem('kb_cache_name');
                }
            }
        } else {
            if (fileUri) {
                console.log('[CacheManager] Validating remote file:', fileUri);
                let isAvailable = false;
                if (this.provider.isFileAvailable) {
                    isAvailable = await this.provider.isFileAvailable(fileUri);
                }
                if (isAvailable) {
                    validationSuccess = true;
                    console.log('[CacheManager] Remote file validated.');
                } else {
                    // Proactive cleanup
                    this.state.kbFileUri.set(null);
                    localStorage.removeItem('kb_file_uri');
                }
            }
        }

        // 2. If validation failed, try to recover
        if (!validationSuccess) {
            console.log('[CacheManager] KB context invalid or missing. Attempting recovery...');

            // Unified recovery logic
            if (hasLocalFiles) {
                console.log('[CacheManager] Re-creating Knowledge Base from local files...');
                const files = this.state.loadedFiles();
                const fileParts = this.kb.buildKnowledgeBaseParts(files);
                const kbText = fileParts.map(p => p.text).join('');

                try {
                    if (useCache) {
                        const newHash = this.kb.calculateKbHash(kbText, config?.modelId || '', systemInstruction);
                        let cacheRes: LLMCacheInfo | null = null;
                        if (this.provider.createCache) {
                            cacheRes = await this.provider.createCache(
                                config?.modelId || this.provider.getDefaultModelId(),
                                systemInstruction,
                                [{ role: 'user', parts: fileParts }],
                                ttlSeconds
                            );
                        }

                        if (cacheRes?.name) {
                            this.state.kbCacheName.set(cacheRes.name);
                            const expireTime = typeof cacheRes.expireTime === 'number'
                                ? cacheRes.expireTime
                                : Date.now() + ttlSeconds * 1000;
                            this.state.kbCacheExpireTime.set(expireTime);
                            localStorage.setItem('kb_cache_name', cacheRes.name);
                            localStorage.setItem('kb_cache_hash', newHash);
                            this.state.kbCacheTokens = cacheRes.usageMetadata?.totalTokenCount || 0;
                            localStorage.setItem('kb_cache_tokens', this.state.kbCacheTokens.toString());
                            this.startStorageTimer();
                            validationSuccess = true;
                            console.log('[CacheManager] Auto-cache creation successful:', cacheRes.name);
                        }
                    } else {
                        const blob = new Blob([kbText], { type: 'text/plain' });
                        if (this.provider.uploadFile) {
                            const { uri } = await this.provider.uploadFile(blob, 'text/plain');
                            fileUri = uri; // Assign to let variable

                            this.state.kbFileUri.set(uri);
                            localStorage.setItem('kb_file_uri', uri);
                            validationSuccess = true;
                            console.log('[CacheManager] Auto-file upload successful:', uri);
                        } else {
                            console.warn('Provider does not support file upload.');
                        }
                    }
                } catch (err) {
                    console.error(useCache ? '[CacheManager] Auto-cache creation failed:' : '[CacheManager] Auto-file upload failed:', err);
                }
            } else {
                // FALLBACK: Last ditch effort - check if the "other" method exists
                console.log('[CacheManager] No local files. Checking fallback context...');
                if (useCache && fileUri) {
                    let isStillAvailable = false;
                    if (this.provider.isFileAvailable) {
                        isStillAvailable = await this.provider.isFileAvailable(fileUri);
                    }

                    if (isStillAvailable) {
                        console.log('[CacheManager] Cache missing, but using existing File URI as fallback.');
                        validationSuccess = true;
                        // Note: kbCacheName was already cleared in Step 1
                    }
                } else if (!useCache && cacheName && this.provider.getCache) {
                    const status = await this.provider.getCache(cacheName);
                    if (status) {
                        console.log('[CacheManager] File missing, but using existing Cache as fallback.');
                        validationSuccess = true;
                        // Note: kbFileUri was already cleared in Step 1
                    }
                }
            }
        }

        // 3. Final failure check
        if (!validationSuccess) {
            console.error('[CacheManager] KB context lost and cannot be recovered.');
            this.state.kbCacheName.set(null);
            this.state.kbFileUri.set(null);
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
                    console.log('[CacheManager] Cleaning up leftover File URI after successful Cache validation.');
                    if (this.provider.deleteAllFiles) {
                        await this.provider.deleteAllFiles(); // Delete all files to be thorough
                    }
                    this.state.kbFileUri.set(null);
                    localStorage.removeItem('kb_file_uri');
                }
            } else {
                // We are in File mode. If there's a leftover Cache, clean it up to save costs.
                if (cacheName) {
                    console.log('[CacheManager] Cleaning up leftover Cache after successful File validation.');
                    if (this.provider.deleteCache) {
                        await this.provider.deleteCache(cacheName);
                    }
                    this.state.kbCacheName.set(null);
                    this.state.kbCacheExpireTime.set(null);
                    this.state.kbCacheTokens = 0;
                    this.stopStorageTimer();
                    localStorage.removeItem('kb_cache_name');
                    localStorage.removeItem('kb_cache_hash');
                    localStorage.removeItem('kb_cache_tokens');
                }
            }
        } catch (cleanupErr) {
            console.warn('[CacheManager] Non-critical cleanup error during mode switch handover:', cleanupErr);
        }
    }

    // ==================== Cache Cleanup ====================

    /**
     * Cleans up the active context cache on the server and resets local cache-related signals.
     */
    async cleanupCache(): Promise<void> {
        if (this.state.kbCacheName()) {
            console.log('[CacheManager] Cleaning up cache:', this.state.kbCacheName());

            // Before clearing, add the current session's storage cost to history
            const currentAcc = this.state.storageCostAccumulated();
            if (currentAcc > 0) {
                this.state.historyStorageCostAccumulated.update(v => v + currentAcc);
                this.state.storageCostAccumulated.set(0);
            }

            if (this.provider.deleteCache) {
                await this.provider.deleteCache(this.state.kbCacheName()!);
            }
            this.state.kbCacheName.set(null);
            this.state.kbCacheExpireTime.set(null);
            localStorage.removeItem('kb_cache_name');
            localStorage.removeItem('kb_cache_hash');
            localStorage.removeItem('kb_cache_expire');
            localStorage.removeItem('kb_cache_tokens'); // Also remove tokens
            localStorage.removeItem('kb_file_uri'); // Clear file URI as well
            this.stopStorageTimer();
            this.state.kbCacheTokens = 0;
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
                count = await this.provider.deleteAllCaches();
            }

            // ALSO delete all uploaded files
            if (this.provider.deleteAllFiles) {
                await this.provider.deleteAllFiles();
            }

            this.state.kbCacheName.set(null);
            this.state.kbCacheExpireTime.set(null);
            this.state.kbFileUri.set(null);
            this.state.storageCostAccumulated.set(0);
            this.state.historyStorageCostAccumulated.set(0);
            this.state.kbCacheTokens = 0;
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
                const currentAcc = this.state.storageCostAccumulated();
                if (currentAcc > 0) {
                    this.state.historyStorageCostAccumulated.update(v => v + currentAcc);
                }

                if (this.provider.deleteCache) {
                    await this.provider.deleteCache(cacheName);
                }
            } catch (err) {
                console.error('[CacheManager] Failed to delete cache from server:', err);
            }
        }

        // Clear local state
        this.state.kbCacheName.set(null);
        this.state.kbCacheExpireTime.set(null);
        this.state.storageCostAccumulated.set(0);
        this.state.kbCacheTokens = 0;
        this.stopStorageTimer();

        localStorage.removeItem('kb_cache_name');
        localStorage.removeItem('kb_cache_expire');
        localStorage.removeItem('kb_cache_tokens');
        localStorage.removeItem('kb_cache_hash');
        localStorage.removeItem('storage_cost_acc');

        console.log('[CacheManager] Cache released successfully.');
    }

    /**
     * Resets all cache-related state without making server calls.
     * Used by wipeLocalSession to reset cache state after clearing storage.
     */
    resetCacheState(): void {
        this.state.kbCacheName.set(null);
        this.state.kbCacheExpireTime.set(null);
        this.state.kbCacheTokens = 0;
        this.stopStorageTimer();

        localStorage.removeItem('kb_cache_name');
        localStorage.removeItem('kb_cache_expire');
        localStorage.removeItem('kb_cache_tokens');
        localStorage.removeItem('kb_cache_hash');
    }
}
