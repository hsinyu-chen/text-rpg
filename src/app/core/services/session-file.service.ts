import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { StorageService } from './storage.service';
import { FileSystemService } from './file-system.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMProvider, LLMProviderConfig } from '@hcs/llm-core';
import { CacheManagerService } from './cache-manager.service';
import { KnowledgeService } from './knowledge.service';

/**
 * File I/O + KB cache hash management for the active session.
 *
 * Methods here are stateful (they read/write `GameStateService` signals,
 * IndexedDB, and the active LLM provider) but DO NOT touch book lifecycle.
 * SessionService wrappers add the post-load `saveCurrentSessionToBook` call
 * so cloud sync sees the change — keeping that out of here avoids a
 * circular dep back into SessionService.
 *
 * `system_files/system_prompt.md` is rejected at the boundary because
 * prompts live in `prompt_store`, not `file_store`. Any caller that
 * reaches here with that path is from a legacy code path.
 */
@Injectable({
    providedIn: 'root'
})
export class SessionFileService {
    private state = inject(GameStateService);
    private storage = inject(StorageService);
    private fileSystem = inject(FileSystemService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private cacheManager = inject(CacheManagerService);
    private kb = inject(KnowledgeService);

    private get provider(): LLMProvider {
        const p = this.providerRegistry.getActive();
        if (!p) throw new Error('No active LLM provider');
        return p;
    }

    private get providerConfig(): LLMProviderConfig {
        return this.providerRegistry.getActiveConfig();
    }

    /**
     * Common KB-cache-invalidation step: drop the remote cache (the orphan
     * keeps billing for its TTL otherwise), pin the new hash, and force the
     * next turn to re-inject context. Both load and single-write paths call
     * this — keeping the three steps together is correctness-critical because
     * any drift here surfaces as stale-context bugs in the engine.
     */
    private async invalidateKbCache(currentHash: string, source: string): Promise<void> {
        console.log(`[SessionFileService] KB content changed (${source}). Invalidating remote cache.`);
        await this.cacheManager.cleanupCache();
        this.state.kbCacheHash.set(currentHash);
        this.state.isContextInjected = false;
    }

    /**
     * Build KB parts and count tokens. Returns 0 when there's nothing to
     * count (countTokens errors on empty parts in most providers, e.g.
     * Gemini requires ≥ 1 part). Shared by the load + single-write paths.
     */
    private async recountKbTokens(contentMap: Map<string, string>, modelId: string): Promise<number> {
        const parts = this.kb.buildKnowledgeBaseParts(contentMap);
        if (parts.length === 0) return 0;
        return this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts }]);
    }

    /**
     * Count tokens for a single file's content, returning 0 for empty /
     * whitespace-only content (countTokens errors on empty parts in most
     * providers). Shared so the per-file load and per-file write paths
     * can't drift on the empty-content contract.
     */
    private async countFileTokens(content: string, modelId: string): Promise<number> {
        if (!content.trim()) return 0;
        return this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts: [{ text: content }] }]);
    }

    /**
     * Loads files from disk (or just rehydrates in-memory state when
     * `pickFolder=false`) and re-establishes KB token counts. Cleans up the
     * remote cache if the KB hash has changed since last save.
     *
     * Propagates errors instead of swallowing them — the SessionService
     * wrapper owns final status handling AND gates the post-load Book save
     * on success. Catching here would let the wrapper persist a half-loaded
     * state to the Book (and via cloud sync, to remote storage).
     */
    async loadFilesIntoState(pickFolder = true): Promise<void> {
        if (pickFolder) {
            await this.fileSystem.selectDirectory();
            await this.fileSystem.syncDiskToDb();
        }
        this.state.status.set('loading');

        const files = await this.fileSystem.loadInitialFiles();
        const contentMap = new Map<string, string>();
        const tokenMap = new Map<string, number>();

        files.forEach((meta, name) => {
            contentMap.set(name, meta.content);
        });
        this.state.loadedFiles.set(contentMap);

        const modelId = this.providerRegistry.getActiveModelId();
        const needsCount: { name: string, content: string }[] = [];

        files.forEach((meta, name) => {
            if (meta.tokens !== undefined) {
                tokenMap.set(name, meta.tokens);
            } else {
                needsCount.push({ name, content: meta.content });
            }
        });

        if (needsCount.length > 0) {
            console.log(`[SessionFileService] Counting tokens for ${needsCount.length} new/updated files...`);
            await Promise.all(needsCount.map(async (item) => {
                const count = await this.countFileTokens(item.content, modelId);
                tokenMap.set(item.name, count);
                await this.storage.saveFile(item.name, item.content, count);
            }));
        }

        this.state.fileTokenCounts.set(tokenMap);

        const storedHash = this.state.kbCacheHash();
        const currentHash = this.state.currentKbHash();

        let totalTokenCount = 0;
        if (storedHash === currentHash && this.state.estimatedKbTokens() > 0) {
            totalTokenCount = this.state.estimatedKbTokens();
            console.log('[SessionFileService] Reusing cached total KB tokens (Est):', totalTokenCount);
        } else {
            totalTokenCount = await this.recountKbTokens(contentMap, modelId);
            console.log('[SessionFileService] Counted new total KB tokens (Est):', totalTokenCount);
        }

        this.state.estimatedKbTokens.set(totalTokenCount);

        // Runs on any hash change — including KB→empty — so the orphan
        // remote cache doesn't keep billing for content the user just removed.
        // When the hash is unchanged there's no reason to force re-injection.
        if (this.state.kbCacheHash() !== currentHash) {
            await this.invalidateKbCache(currentHash, 'load');
        }
    }

    /**
     * Bulk-replaces `file_store` contents with the given map. Skips
     * `system_files/system_prompt.md` because that lives in `prompt_store`.
     * Caller is responsible for re-running `loadFilesIntoState` after.
     */
    async writeFilesToStorage(files: Map<string, string>): Promise<void> {
        await this.storage.clearFiles();
        // IDB writes have no remote rate limit (unlike LLM countTokens), so
        // parallel is safe and meaningfully faster on bulk imports. Both
        // path-suffixes are blocked to match writeSingleFile's guard —
        // prompts live in prompt_store, not file_store.
        const writes = Array.from(files.entries())
            .filter(([name]) => name !== 'system_files/system_prompt.md' && name !== 'system_prompt.md')
            .map(([name, content]) => this.storage.saveFile(name, content));
        await Promise.all(writes);
    }

    /**
     * Writes one file to storage, updates the in-memory token + content
     * maps, and invalidates the remote KB cache if the new content shifted
     * the KB hash. Returns nothing — caller decides whether to bump the
     * book save timestamp.
     */
    async writeSingleFile(filePath: string, content: string): Promise<void> {
        if (filePath === 'system_files/system_prompt.md' || filePath === 'system_prompt.md') {
            throw new Error('Refused to write system_prompt.md as a file — prompts live in prompt_store now.');
        }

        const modelId = this.providerRegistry.getActiveModelId();
        const count = await this.countFileTokens(content, modelId);
        await this.storage.saveFile(filePath, content, count);

        this.state.loadedFiles.update(map => {
            const newMap = new Map(map);
            newMap.set(filePath, content);
            return newMap;
        });

        this.state.fileTokenCounts.update(map => {
            const newMap = new Map(map);
            newMap.set(filePath, count);
            return newMap;
        });

        const currentHash = this.state.currentKbHash();
        if (this.state.kbCacheHash() !== currentHash) {
            await this.invalidateKbCache(currentHash, 'single update');
            const totalTokenCount = await this.recountKbTokens(this.state.loadedFiles(), modelId);
            this.state.estimatedKbTokens.set(totalTokenCount);
        }
    }
}
