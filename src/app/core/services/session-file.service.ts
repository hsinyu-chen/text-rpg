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
                const count = await this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts: [{ text: item.content }] }]);
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
            // Lazy: building parts is only needed on the cache-miss path;
            // skip the work when we'll reuse the cached estimate.
            const partsForCount = this.kb.buildKnowledgeBaseParts(contentMap);
            // Guard: countTokens with an empty parts array errors on most
            // providers (Gemini requires ≥ 1 part). Empty KB → totalCount stays 0.
            if (partsForCount.length > 0) {
                totalTokenCount = await this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts: partsForCount }]);
            }
            console.log('[SessionFileService] Counted new total KB tokens (Est):', totalTokenCount);
        }

        this.state.estimatedKbTokens.set(totalTokenCount);

        // Cache invalidation runs on any hash change — including KB→empty —
        // so the orphan remote cache doesn't keep billing for content the
        // user just removed. isContextInjected reset lives in the same
        // branch (matches writeSingleFile) — when the hash is unchanged
        // there's no reason to force the next turn to re-inject.
        if (this.state.kbCacheHash() !== currentHash) {
            console.log('[SessionFileService] KB content changed. Invalidating remote cache.');
            await this.cacheManager.cleanupCache();
            this.state.kbCacheHash.set(currentHash);
            this.state.isContextInjected = false;
        }
    }

    /**
     * Bulk-replaces `file_store` contents with the given map. Skips
     * `system_files/system_prompt.md` because that lives in `prompt_store`.
     * Caller is responsible for re-running `loadFilesIntoState` after.
     */
    async writeFilesToStorage(files: Map<string, string>): Promise<void> {
        await this.storage.clearFiles();
        for (const [name, content] of files.entries()) {
            // Block both paths to match writeSingleFile's guard. Prompts live
            // in prompt_store; bulk import was previously only filtering the
            // `system_files/` path which let a root `system_prompt.md` slip
            // into file_store.
            if (name === 'system_files/system_prompt.md' || name === 'system_prompt.md') continue;
            await this.storage.saveFile(name, content);
        }
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
        const count = await this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts: [{ text: content }] }]);
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
            console.log('[SessionFileService] KB content changed via single update. Invalidating remote cache.');
            // cleanupCache (not resetCacheState) so the now-stale cache is
            // also deleted server-side. Otherwise the orphan keeps billing
            // for the rest of its TTL while we generate a fresh one next turn.
            await this.cacheManager.cleanupCache();
            this.state.kbCacheHash.set(currentHash);
            // Match loadFilesIntoState's KB-changed branch: reset so the next
            // turn re-injects the updated context. Pre-refactor updateSingleFile
            // omitted this — when cache is disabled the engine would otherwise
            // keep using the previously injected context referencing stale KB.
            this.state.isContextInjected = false;

            const contentMap = this.state.loadedFiles();
            const partsForCount = this.kb.buildKnowledgeBaseParts(contentMap);
            // Same empty-parts guard as loadFilesIntoState — countTokens errors
            // on empty parts in most providers.
            let totalTokenCount = 0;
            if (partsForCount.length > 0) {
                totalTokenCount = await this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts: partsForCount }]);
            }
            this.state.estimatedKbTokens.set(totalTokenCount);
        }
    }
}
