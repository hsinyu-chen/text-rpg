import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { StorageService } from './storage.service';
import { FileSystemService } from './file-system.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMProvider } from './llm-provider';
import { CacheManagerService } from './cache-manager.service';
import { KnowledgeService } from './knowledge.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SessionSave, Scenario } from '../models/types';
import { GAME_INTENTS } from '../constants/game-intents';
import { getCoreFilenames, getSectionHeaders, getUIStrings } from '../constants/engine-protocol';
import { LOCALES } from '../constants/locales';
import { InjectionService } from './injection.service';

@Injectable({
    providedIn: 'root'
})
export class SessionService {
    private state = inject(GameStateService);
    private storage = inject(StorageService);
    private fileSystem = inject(FileSystemService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private cacheManager = inject(CacheManagerService);
    private kb = inject(KnowledgeService);
    private snackBar = inject(MatSnackBar);
    private injection = inject(InjectionService);

    private get provider(): LLMProvider {
        const p = this.providerRegistry.getActive();
        if (!p) throw new Error('No active LLM provider');
        return p;
    }

    private get systemInstructionCache() { return this.state.systemInstructionCache(); }
    private set isContextInjected(v: boolean) { this.state.isContextInjected = v; }

    /**
     * Initializes a new game session using scenario templates.
     */
    async startNewGame(profile: {
        name: string,
        faction: string,
        background: string,
        interests: string,
        appearance: string,
        coreValues: string
    }, scenario: Scenario) {
        this.state.status.set('generating');
        const scenarioId = scenario.id;
        const scenarioFiles = scenario.files;

        try {
            console.log(`[SessionService] Starting New Game (${scenarioId}) with profile:`, profile);

            // CRITICAL: Clear existing session and files to prevent cross-session pollution
            await this.storage.clear();
            await this.storage.clearFiles();
            console.log(`[SessionService] Storage cleared for new game (${scenarioId})`);

            const coreKeys: (keyof ReturnType<typeof getCoreFilenames>)[] = [
                'BASIC_SETTINGS', 'STORY_OUTLINE', 'CHARACTER_STATUS',
                'ASSETS', 'TECH_EQUIPMENT', 'WORLD_FACTIONS',
                'MAGIC', 'PLANS', 'INVENTORY'
            ];

            const loadedMap = new Map<string, string>();

            const replacements = [
                { pattern: /<!uc_name(?:\|[^>]+)?>/g, replacement: profile.name },
                { pattern: /<!uc_faction(?:\|[^>]+)?>/g, replacement: profile.faction },
                { pattern: /<!uc_background(?:\|[^>]+)?>/g, replacement: profile.background },
                { pattern: /<!uc_interests(?:\|[^>]+)?>/g, replacement: profile.interests },
                { pattern: /<!uc_appearance(?:\|[^>]+)?>/g, replacement: profile.appearance },
                { pattern: /<!uc_core_values(?:\|[^>]+)?>/g, replacement: profile.coreValues },
            ];

            for (const key of coreKeys) {
                const filename = scenarioFiles[key];
                if (!filename) {
                    console.warn(`[SessionService] Key ${key} not defined for scenario ${scenarioId}`);
                    continue;
                }

                let content = '';
                try {
                    content = await this.fileSystem.getFallbackContent(`${scenario.baseDir}/${filename}`);
                } catch (e) {
                    console.error(`[SessionService] Failed to load ${key} (${filename}) for scenario ${scenarioId}`, e);
                    continue;
                }

                if (!content) {
                    console.warn(`[SessionService] Content empty for ${key} (${filename})`);
                    content = '';
                }

                // Apply specific profile replacements
                for (const r of replacements) {
                    content = content.replace(r.pattern, r.replacement);
                }

                // Robust Cleanup: Replace any remaining <!tag|default|label> or <!tag|default> with their default text
                // then replace any remaining <!tag> with empty string to avoid showing variables
                content = content.replace(/<![^|>]*(?:\|([^|>]*))?(?:\|[^>]+)?>/g, (match, def) => def ? def.trim() : '');

                // Story Outline: Inject last_scene marker for startup
                // Check if this IS the Story Outline file (in any language)
                // We search for a locale that uses this filename as its story outline
                const matchedLocale = Object.values(LOCALES).find(l => l.coreFilenames.STORY_OUTLINE === filename);
                if (matchedLocale) {
                    const sceneHeaders = getSectionHeaders(matchedLocale.id);
                    const startSceneHeader = sceneHeaders.START_SCENE;

                    if (content.includes(startSceneHeader)) {
                        const sceneContent = content.split(startSceneHeader)[1].split('---')[0].trim();
                        content += `\n\n# last_scene\n${sceneContent}`;
                        console.log(`[SessionService] Injected last_scene marker into ${filename} using header ${startSceneHeader}`);
                    } else {
                        console.warn(`[SessionService] FAILED to inject last_scene: Header "${startSceneHeader}" not found in ${filename}`);
                    }
                }

                // Save to IndexedDB using the ACTUAL filename found
                await this.storage.saveFile(filename, content);
                loadedMap.set(filename, content);
            }

            // Update local state and clear history
            this.state.loadedFiles.set(loadedMap);
            this.state.messages.set([]);
            this.state.sunkUsageHistory.set([]); // Reset sunk usage history
            await this.storage.set('chat_history', []);
            await this.storage.set('sunk_usage_history', []); // Clear from IDB
            this.isContextInjected = false;

            // Sync state
            await this.loadFiles(false);

            // Notify success
            const ui = getUIStrings(this.state.config()?.outputLanguage);
            this.snackBar.open(ui.GAME_INIT_SUCCESS, 'OK', { duration: 3000 });

            // Note: Caller (GameEngine) still needs to trigger startSession if needed, 
            // but GameEngine.startNewGame previously called startSession.
            // Since startSession is just "local init", we can return true indicating success.
            return true;

        } catch (e) {
            console.error('[SessionService] Failed to initialize new game', e);
            const ui = getUIStrings(this.state.config()?.outputLanguage);
            this.snackBar.open(ui.GAME_INIT_FAILED, ui.CLOSE, { duration: 5000 });
            throw e;
        } finally {
            this.state.status.set('idle');
        }
    }

    /**
     * Completely wipes all local game progress, including IndexedDB stores and signals.
     */
    async wipeLocalSession() {
        console.log('[SessionService] Wiping local session...');
        this.state.status.set('loading');
        try {
            // 1. Clear all IndexedDB stores
            await this.storage.clear(); // chat_store
            await this.storage.clearFiles(); // file_store

            // 2. Reset all signals and local state
            this.state.messages.set([]);
            this.state.loadedFiles.set(new Map());

            this.cacheManager.resetCacheState();

            this.state.tokenUsage.set({ freshInput: 0, cached: 0, output: 0, total: 0 });
            this.state.estimatedKbTokens.set(0);
            this.state.estimatedCost.set(0);
            this.state.lastTurnUsage.set(null);
            this.state.lastTurnCost.set(0);
            this.state.historyStorageUsageAccumulated.set(0);
            this.state.sunkUsageHistory.set([]);

            localStorage.removeItem('history_storage_usage_acc');
            localStorage.removeItem('kb_storage_usage_acc');
            this.state.storageUsageAccumulated.set(0);

            console.log('[SessionService] Local session wiped successfully.');
        } catch (e) {
            console.error('Failed to wipe local session', e);
            throw e;
        } finally {
            this.state.status.set('idle');
        }
    }

    /**
     * Exports the current session state for saving.
     */
    exportSession(): SessionSave {
        const msgs = this.state.messages();
        const lastModelMsg = [...msgs].reverse().find(m => m.role === 'model' && m.content && !m.isRefOnly);
        const preview = lastModelMsg?.content?.substring(0, 200) || '';

        return {
            id: '',
            name: '',
            timestamp: Date.now(),
            messages: msgs,
            tokenUsage: this.state.tokenUsage(),
            estimatedCost: this.state.estimatedCost(),
            historyStorageUsage: this.state.historyStorageUsageAccumulated(),
            sunkUsageHistory: this.state.sunkUsageHistory(),
            storyPreview: preview,
            kbHash: this.state.currentKbHash()
        };
    }

    /**
     * Imports a saved session state.
     */
    async importSession(save: SessionSave) {
        // Restore messages
        this.state.messages.set(save.messages);
        await this.storage.set('chat_history', save.messages);

        // Restore usage stats
        this.state.tokenUsage.set(save.tokenUsage);
        this.state.estimatedCost.set(save.estimatedCost);
        this.state.sunkUsageHistory.set(save.sunkUsageHistory || []);

        // Restore history usage (Token-Seconds)
        const historyUsage = save.historyStorageUsage || 0;
        this.state.historyStorageUsageAccumulated.set(historyUsage);
        localStorage.setItem('history_storage_usage_acc', historyUsage.toString());

        if (save.messages.length > 0) {
            this.isContextInjected = true;
        }

        console.log('[SessionService] Session imported:', save.name);
    }

    /**
     * Extracts the act/chapter name from the chat history for naming save slots.
     * Follows logic inspired by chat-input.component.ts exportToMarkdown.
     */
    extractActName(): string | null {
        const messages = this.state.messages();

        // Search backwards for the most recent model message that contains an act/chapter marker
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === 'model' && msg.content) {
                // Primary pattern: ## Act.1
                const actMatch = msg.content.match(/## Act\.(\d+)/i);
                if (actMatch) {
                    return `Act.${actMatch[1]}`;
                }

                // Fallback: 第N章
                const zhMatch = msg.content.match(/第\s*(\d+)\s*章/);
                if (zhMatch) {
                    return `第${zhMatch[1]}章`;
                }
            }
        }

        return null;
    }

    /**
     * Bulk imports files into the persistent store (IndexedDB) and reloads the engine state.
     */
    async importFiles(files: Map<string, string>) {
        this.state.status.set('loading');
        try {
            await this.storage.clearFiles();
            for (const [name, content] of files.entries()) {
                if (name !== 'system_files/system_prompt.md') {
                    await this.storage.saveFile(name, content);
                }
            }
            await this.loadFiles(false);
        } catch (err) {
            console.error('[SessionService] Import failed', err);
            throw err;
        } finally {
            this.state.status.set('idle');
        }
    }

    /**
     * Updates a single file in storage and refreshes the loadedFiles signal.
     */
    async updateSingleFile(filePath: string, content: string): Promise<void> {
        // 1. Handle special files (system prompts)
        if (filePath === 'system_files/system_prompt.md' || filePath === 'system_prompt.md') {
            await this.injection.saveToService('system_main', content);
        } else {
            // Save regular file and compute tokens
            const modelId = this.state.config()?.modelId || this.provider.getDefaultModelId();
            const count = await this.provider.countTokens(modelId, [{ role: 'user', parts: [{ text: content }] }]);
            await this.storage.saveFile(filePath, content, count);

            this.state.loadedFiles.update(map => {
                const newMap = new Map(map);
                newMap.set(filePath, content);
                return newMap;
            });

            // Update individual token count in state
            this.state.fileTokenCounts.update(map => {
                const newMap = new Map(map);
                newMap.set(filePath, count);
                return newMap;
            });
        }

        console.log('[SessionService] Updated file:', filePath);

        // 2. Invalidate cache if KB hash changes (immediate UI feedback)
        const currentHash = this.state.currentKbHash();
        if (localStorage.getItem('kb_cache_hash') !== currentHash) {
            console.log('[SessionService] KB Content changed through single update. Invalidating remote state.');
            this.state.kbCacheName.set(null);
            localStorage.removeItem('kb_cache_name');
            localStorage.setItem('kb_cache_hash', currentHash);

            // Also re-calculate total estimated tokens
            const contentMap = this.state.loadedFiles();
            const partsForCount = this.kb.buildKnowledgeBaseParts(contentMap);
            const modelId = this.state.config()?.modelId || this.provider.getDefaultModelId();
            const totalTokenCount = await this.provider.countTokens(modelId, [{ role: 'user', parts: partsForCount }]);
            this.state.estimatedKbTokens.set(totalTokenCount);
            localStorage.setItem('kb_cache_tokens', totalTokenCount.toString());
        }
    }

    /**
     * Loads files from a directory and initializes the Knowledge Base.
     */
    async loadFiles(pickFolder = true) {
        try {
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


            // Calculate tokens
            const modelId = this.state.config()?.modelId || this.provider.getDefaultModelId();
            const needsCount: { name: string, content: string }[] = [];

            files.forEach((meta, name) => {
                if (meta.tokens !== undefined) {
                    tokenMap.set(name, meta.tokens);
                } else {
                    needsCount.push({ name, content: meta.content });
                }
            });

            if (needsCount.length > 0) {
                console.log(`[SessionService] Counting tokens for ${needsCount.length} new/updated files...`);
                await Promise.all(needsCount.map(async (item) => {
                    const count = await this.provider.countTokens(modelId, [{ role: 'user', parts: [{ text: item.content }] }]);
                    tokenMap.set(item.name, count);
                    await this.storage.saveFile(item.name, item.content, count);
                }));
            }

            const mainPrompt = await this.storage.getPrompt('system_main');
            if (mainPrompt) {
                if (mainPrompt.tokens) {
                    tokenMap.set('system_files/system_prompt.md', mainPrompt.tokens);
                } else {
                    const count = await this.provider.countTokens(modelId, [{ role: 'user', parts: [{ text: mainPrompt.content }] }]);
                    tokenMap.set('system_files/system_prompt.md', count);
                    await this.storage.savePrompt('system_main', mainPrompt.content, count);
                }
            }
            this.state.fileTokenCounts.set(tokenMap);
            const partsForCount = this.kb.buildKnowledgeBaseParts(contentMap);

            const savedHash = localStorage.getItem('kb_cache_hash');
            const cachedTotal = localStorage.getItem('kb_cache_tokens');
            const currentHashTmp = this.state.currentKbHash(); // Use reactive hash

            let totalTokenCount = 0;
            if (savedHash === currentHashTmp && cachedTotal) {
                totalTokenCount = parseInt(cachedTotal);
                console.log('[SessionService] Reusing cached total KB tokens:', totalTokenCount);
            } else {
                totalTokenCount = await this.provider.countTokens(modelId, [{ role: 'user', parts: partsForCount }]);
                localStorage.setItem('kb_cache_tokens', totalTokenCount.toString());
                console.log('[SessionService] Counted new total KB tokens:', totalTokenCount);
            }

            this.state.estimatedKbTokens.set(totalTokenCount);
            console.log('[SessionService] Estimated KB Tokens:', totalTokenCount);

            const currentHash = this.state.currentKbHash();

            const hasKbContent = Array.from(contentMap.keys()).some(path => !path.startsWith('system_files/') && path !== 'system_prompt.md');

            if (hasKbContent) {
                if (localStorage.getItem('kb_cache_hash') !== currentHash) {
                    console.log('[SessionService] KB Content changed. Invalidating remote state.');
                    this.state.kbCacheName.set(null);
                    localStorage.removeItem('kb_cache_name');
                    localStorage.setItem('kb_cache_hash', currentHash);
                }

                this.isContextInjected = false;
                this.state.status.set('idle');
            }
        } catch (e) {
            console.error(e);
            this.state.status.set('error');
        }
    }

    /**
     * Loads chat history from local persistent storage.
     */
    async loadHistoryFromStorage() {
        const saved = await this.storage.get('chat_history');
        if (saved && Array.isArray(saved)) {
            const migrated = saved.map(m => {
                if (!m.intent) return m;
                if (m.intent === '<行動意圖>') return { ...m, intent: GAME_INTENTS.ACTION };
                if (m.intent === '<快轉>') return { ...m, intent: GAME_INTENTS.FAST_FORWARD };
                if (m.intent === '<系統>') return { ...m, intent: GAME_INTENTS.SYSTEM };
                if (m.intent === '<存檔>') return { ...m, intent: GAME_INTENTS.SAVE };
                if (m.intent === '<繼續>') return { ...m, intent: GAME_INTENTS.CONTINUE };
                return m;
            });
            this.state.messages.set(migrated);
            if (saved.length > 0) {
                this.isContextInjected = true;
            }
        }

        // Restore sunk usage history
        const sunk = await this.storage.get('sunk_usage_history');
        if (Array.isArray(sunk)) {
            this.state.sunkUsageHistory.set(sunk);
        }
    }
}
