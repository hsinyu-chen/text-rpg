import { Injectable, inject, signal, effect } from '@angular/core';
import { GameStateService } from './game-state.service';
import { StorageService } from './storage.service';
import { FileSystemService } from './file-system.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMProvider } from './llm-provider';
import { CacheManagerService } from './cache-manager.service';
import { CostService } from './cost.service';
import { KnowledgeService } from './knowledge.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SessionSave, Scenario, Book } from '../models/types';
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
    private costService = inject(CostService);
    private kb = inject(KnowledgeService);
    private snackBar = inject(MatSnackBar);
    private injection = inject(InjectionService);

    constructor() {
        effect(() => {
            const id = this.currentBookId();
            if (id) {
                localStorage.setItem('last_active_book_id', id);
            } else {
                localStorage.removeItem('last_active_book_id');
            }
        });
    }

    // Signals
    currentBookId = signal<string | null>(null);

    /**
     * Initializes the SessionService. 
     * Restores the last active book ID to ensure session continuity.
     */
    async init() {
        const lastBookId = localStorage.getItem('last_active_book_id');
        if (lastBookId) {
            try {
                // Check if it exists first to avoid unnecessary load attempts
                const book = await this.storage.getBook(lastBookId);
                if (book) {
                    console.log(`[SessionService] Auto-loading last book: ${book.name} (${lastBookId})`);
                    await this.loadBook(lastBookId);
                } else {
                    console.warn(`[SessionService] Last active book ${lastBookId} not found. Clearing.`);
                    localStorage.removeItem('last_active_book_id');
                    this.currentBookId.set(null);
                }
            } catch (error) {
                console.error('[SessionService] Failed to auto-load last book', error);
                // Ensure we don't leave the app in a broken loading state
                this.state.status.set('idle');
                this.currentBookId.set(null);
                localStorage.removeItem('last_active_book_id');
            }
        }

        // Auto-persist future changes
    }

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
            // Auto-save current if exists, then unload
            await this.unloadCurrentSession(true);

            // Create a new Book entry
            const newBookId = crypto.randomUUID();
            this.currentBookId.set(newBookId);

            // We don't save the book object immediately here; we just set the ID.
            // The first auto-save or unload will actually write the book to DB.
            // But to ensure it exists in the list, we can create a skeletal one.
            const newBook: Book = {
                id: newBookId,
                name: profile.name || 'New Adventure',
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                preview: 'Beginning...',
                messages: [],
                files: [],
                prompts: {},
                stats: {
                    tokenUsage: { freshInput: 0, cached: 0, output: 0, total: 0 },
                    estimatedCost: 0,
                    historyStorageUsage: 0,
                    sunkUsageHistory: [],
                    kbCacheName: null,
                    kbCacheExpireTime: null,
                    kbCacheTokens: 0,
                    kbCacheHash: null,
                    kbStorageUsageAcc: 0
                }
            };
            await this.storage.saveBook(newBook);

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
    /**
     * Unloads the current session from active memory/storage.
     * Optionally serializes current state to a Book before clearing.
     */
    async unloadCurrentSession(save: boolean) {
        console.log('[SessionService] Unloading current session...', { save });
        this.state.status.set('loading');
        try {
            if (save) {
                await this.saveCurrentSessionToBook();
            }

            // 1. Clear all IndexedDB stores used for ACTIVE session
            await this.storage.clear(); // chat_store
            await this.storage.clearFiles(); // file_store
            await this.storage.clearPrompts(); // prompt_store (assuming prompts are per-session)

            // 2. Reset all signals and local state
            this.state.messages.set([]);
            this.state.loadedFiles.set(new Map());

            // 3. Reset Cache/Cost signals but DO NOT delete server cache
            // The metadata was saved to the Book in saveCurrentSessionToBook()
            this.cacheManager.resetCacheState(); // This just clears local keys/signals

            this.state.tokenUsage.set({ freshInput: 0, cached: 0, output: 0, total: 0 });
            this.state.estimatedKbTokens.set(0);
            this.state.lastTurnUsage.set(null);
            this.state.lastTurnCost.set(0);
            this.state.historyStorageUsageAccumulated.set(0);
            this.state.sunkUsageHistory.set([]);
            this.state.storageUsageAccumulated.set(0);

            // 4. Clear active session localstorage keys
            localStorage.removeItem('history_storage_usage_acc');
            localStorage.removeItem('kb_storage_usage_acc');
            localStorage.removeItem('kb_slot_id');
            localStorage.removeItem('kb_slot_name');
            // Cache keys are cleared by cacheManager.resetCacheState()

            this.currentBookId.set(null);

            console.log('[SessionService] Session unloaded successfully.');
        } catch (e) {
            console.error('Failed to unload session', e);
            throw e;
        } finally {
            this.state.status.set('idle');
        }
    }

    /**
     * Dehydrates the currently active session into a Book object and saves it to IndexedDB.
     */
    async startEmptySession() {
        // 1. Unload current session and save it
        if (this.currentBookId()) {
            await this.unloadCurrentSession(true);
        } else {
            // Just clear if no book was active (clean state)
            await this.unloadCurrentSession(false);
        }

        // 2. Create new empty Book ID
        const bookId = crypto.randomUUID();
        this.currentBookId.set(bookId);

        // 3. Initialize fresh stats
        this.state.tokenUsage.set({ freshInput: 0, cached: 0, output: 0, total: 0 });
        this.cacheManager.resetCacheState();

        // 4. Save initial empty book to persist it immediately
        const book: Book = {
            id: bookId,
            name: 'New Session',
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            preview: 'Empty Session',
            messages: [],
            files: [],
            prompts: {},
            stats: {
                tokenUsage: this.state.tokenUsage(),
                estimatedCost: 0,
                historyStorageUsage: 0,
                sunkUsageHistory: [],
                kbStorageUsageAcc: 0,
                kbCacheName: null,
                kbCacheExpireTime: null,
                kbCacheTokens: 0,
                kbCacheHash: null,
                kbSlotId: undefined,
                kbSlotName: undefined
            }
        };

        await this.storage.saveBook(book);
        console.log('[SessionService] Started empty session:', bookId);
    }
    async saveCurrentSessionToBook() {
        const bookId = this.currentBookId();
        if (!bookId) {
            console.warn('[SessionService] No current book ID to save to.');
            return;
        }

        console.log(`[SessionService] Saving current session to Book ${bookId}...`);

        // Gather data
        const messages = this.state.messages();
        const filesMap = this.state.loadedFiles();
        const fileTokens = this.state.fileTokenCounts();

        const files: { name: string, content: string, tokens?: number }[] = [];
        for (const [name, content] of filesMap.entries()) {
            files.push({ name, content, tokens: fileTokens.get(name) });
        }

        // Get system prompts via storage service (async)
        // Or we could just assume system_files/system_prompt.md is in filesMap if loaded?
        // Actually, prompts in 'prompt_store' are separate if using InjectionService logic.
        // For simplicity, let's grab what we can from storage or re-construction.
        // Assuming prompt_store is per-session, we blindly grab all.
        // TODO: Access prompt_store directly? 
        // For now, let's assume system_prompt.md is often in loadedFiles or we don't strictly need to persist prompts separate from files if we rely on file loading.
        // BUT, user code edits system_prompt via InjectionService which saves to prompt_store.
        const prompts: Record<string, { content: string, tokens?: number }> = {};
        const mainPrompt = await this.storage.getPrompt('system_main');
        if (mainPrompt) prompts['system_main'] = { content: mainPrompt.content, tokens: mainPrompt.tokens };

        // Cache Metadata
        const kbCacheName = this.state.kbCacheName();
        const kbCacheExpireTime = this.state.kbCacheExpireTime();
        const kbCacheTokens = this.state.kbCacheTokens();
        // Since hash might be computed, let's grab from reactive or calc
        const kbCacheHash = localStorage.getItem('kb_cache_hash');

        // Usage Stats
        const tokenUsage = this.state.tokenUsage();
        const historyStorageUsage = this.state.historyStorageUsageAccumulated();
        const sunkUsageHistory = this.state.sunkUsageHistory();
        const kbStorageUsageAcc = this.state.storageUsageAccumulated(); // Active accumulation
        const kbSlotId = localStorage.getItem('kb_slot_id') || undefined;
        const kbSlotName = localStorage.getItem('kb_slot_name') || undefined;

        // Calculate estimated cost dynamically (same as sidebar-cost-prediction)
        const activeProvider = this.providerRegistry.getActive();
        const activeModelId = this.state.config()?.modelId || activeProvider?.getDefaultModelId();
        const model = activeProvider?.getAvailableModels().find(m => m.id === activeModelId);
        let estimatedCost = 0;
        if (model) {
            const activeTxn = this.costService.calculateSessionTransactionCost(messages, model);
            let sunkTxn = 0;
            for (const usage of sunkUsageHistory) {
                sunkTxn += this.costService.calculateTurnCost({
                    prompt: usage.prompt,
                    cached: usage.cached,
                    candidates: usage.candidates
                }, model.id);
            }
            const storageCost = this.costService.calculateStorageCost(kbStorageUsageAcc + historyStorageUsage, model.id);
            estimatedCost = activeTxn + sunkTxn + storageCost;
        }

        const lastParams = [...this.state.messages()].reverse().find(m => m.role === 'model')?.content?.substring(0, 100) || '...';

        const book: Book = {
            id: bookId,
            name: this.state.messages().length > 0 ? (this.extractActName() || 'Untitled Session') : 'Empty Session', // Could optimize to not overwrite name if user set it customly? Ideally we just update auto-generated names.
            // For now, let's preserve existing name if we fetch it first?
            // Expensive to fetch just to check name. Let's start with auto-updating.
            // Better: `saveCurrentSessionToBook` should arguably just UPDATE the existing book in DB.
            createdAt: Date.now(), // This will be clobbered if we treat this as "create new". We need to READ first.
            lastActiveAt: Date.now(),
            preview: lastParams,
            messages,
            files,
            prompts,
            stats: {
                tokenUsage,
                estimatedCost,
                historyStorageUsage,
                sunkUsageHistory,
                kbCacheName,
                kbCacheExpireTime,
                kbCacheTokens,
                kbCacheHash,
                kbStorageUsageAcc,
                kbSlotId,
                kbSlotName
            }
        };

        // Attempt to merge with existing to preserve ID/Name/Created 
        const existing = await this.storage.getBook(bookId);
        if (existing) {
            book.name = existing.name; // Keep user-defined name
            book.createdAt = existing.createdAt;
        }

        await this.storage.saveBook(book);
        console.log(`[SessionService] Book ${bookId} saved.`);
    }

    /**
     * Loads a Book into the active session.
     */
    async loadBook(id: string) {
        console.log(`[SessionService] Loading Book ${id}...`);

        // 1. Unload current (Save it first!)
        if (this.currentBookId()) {
            await this.unloadCurrentSession(true);
        }

        // 2. Fetch target Book
        const book = await this.storage.getBook(id);
        if (!book) {
            throw new Error(`Book ${id} not found!`);
        }

        this.state.status.set('loading');
        try {
            // 3. Rehydrate State
            this.currentBookId.set(book.id);

            // Restore Files
            await this.storage.clearFiles();
            const filesMap = new Map<string, string>();
            const tokensMap = new Map<string, number>();

            for (const f of book.files) {
                await this.storage.saveFile(f.name, f.content, f.tokens);
                filesMap.set(f.name, f.content);
                if (f.tokens) tokensMap.set(f.name, f.tokens);
            }
            this.state.loadedFiles.set(filesMap);
            this.state.fileTokenCounts.set(tokensMap);

            // Restore Prompts
            await this.storage.clearPrompts();
            for (const [key, p] of Object.entries(book.prompts)) {
                await this.storage.savePrompt(key, p.content, p.tokens);
            }

            // Restore Messages
            await this.storage.clear(); // chat_store
            // We need to re-save messages to chat_store so `loadHistoryFromStorage` works? 
            // Or just set signals directly. `storage.set('chat_history', ...)` is important for persistence within session.
            await this.storage.set('chat_history', book.messages);
            this.state.messages.set(book.messages);
            if (book.messages.length > 0) this.isContextInjected = true;

            // Restore Stats
            this.state.tokenUsage.set(book.stats.tokenUsage);
            this.state.historyStorageUsageAccumulated.set(book.stats.historyStorageUsage);
            localStorage.setItem('history_storage_usage_acc', book.stats.historyStorageUsage.toString());
            this.state.sunkUsageHistory.set(book.stats.sunkUsageHistory);

            // Restore Cost Active Accumulation
            this.state.storageUsageAccumulated.set(book.stats.kbStorageUsageAcc);
            localStorage.setItem('kb_storage_usage_acc', book.stats.kbStorageUsageAcc.toString());

            // Restore Cache Metadata
            const stats = book.stats;
            if (stats.kbCacheName) {
                this.state.kbCacheName.set(stats.kbCacheName);
                if (stats.kbCacheExpireTime) this.state.kbCacheExpireTime.set(stats.kbCacheExpireTime);
                this.state.kbCacheTokens.set(stats.kbCacheTokens);

                // Set localStorage keys for CacheManager/Services to pick up
                localStorage.setItem('kb_cache_name', stats.kbCacheName);
                if (stats.kbCacheHash) localStorage.setItem('kb_cache_hash', stats.kbCacheHash);
                if (stats.kbCacheExpireTime) localStorage.setItem('kb_cache_expire', stats.kbCacheExpireTime.toString());
                localStorage.setItem('kb_cache_tokens', stats.kbCacheTokens.toString());

                // Restart Timer
                this.cacheManager.startStorageTimer();
            } else {
                this.cacheManager.resetCacheState(); // Ensures clean slate if book has no cache
            }

            // Restore KB Slot
            if (stats.kbSlotId) {
                localStorage.setItem('kb_slot_id', stats.kbSlotId);
                // Also update driveService if needed, but SidebarFileSync handles initialization from localStorage
                // We might need to poke DriveService if it's already instantiated
                // inject -> driveService.currentSlotId.set(stats.kbSlotId);
            } else {
                localStorage.removeItem('kb_slot_id');
            }

            if (stats.kbSlotName) {
                localStorage.setItem('kb_slot_name', stats.kbSlotName);
            } else {
                localStorage.removeItem('kb_slot_name');
            }

            console.log(`[SessionService] Book ${id} loaded.`);
        } catch (e) {
            console.error(`[SessionService] Failed to load book ${id} `, e);
            this.state.status.set('error');
            throw e;
        } finally {
            this.state.status.set('idle');
        }
    }

    async renameBook(id: string, newName: string) {
        if (!newName || !newName.trim()) return;
        const book = await this.storage.getBook(id);
        if (book) {
            book.name = newName.trim();
            await this.storage.saveBook(book);
        }
    }

    async createNextBook() {
        const currentId = this.currentBookId();
        if (!currentId) return;

        // 1. Determine Naming & State BEFORE Unloading
        // We use the current in-memory state which is most up-to-date
        const actName = this.extractActName() || 'Act.1';
        let currentActNum = 1;
        const match = actName.match(/Act\.(\d+)/i) || actName.match(/第\s*(\d+)\s*章/);
        if (match) {
            currentActNum = parseInt(match[1]);
        }

        const kbSlotName = localStorage.getItem('kb_slot_name') || 'Default'; // Active slot
        // If we are "Creating Next", it implies the current session effectively IS "Act N".
        // Example: Playing "Legacy Adventure", reached Act 2. 
        // User clicks "Create Next". Old book becomes "Legacy Adventure Act.2". New Book becomes "Legacy Adventure Act.3".

        const newNameForOldBook = `${kbSlotName} Act.${currentActNum}`;
        const newNameForNewBook = `${kbSlotName} Act.${currentActNum + 1}`;

        console.log(`[SessionService] Create Next: Renaming current to "${newNameForOldBook}", creating "${newNameForNewBook}"`);

        // 2. Unload and Save Current
        await this.unloadCurrentSession(true);

        // 3. Update Old Book Name
        const oldBook = await this.storage.getBook(currentId);
        if (!oldBook) return;

        oldBook.name = newNameForOldBook;

        // Critical: Ensure files exist. If oldBook.files is empty, it means save failed or state was broken.
        // But we just called unloadCurrentSession(true) which calls saveCurrentSessionToBook.
        // saveCurrentSessionToBook grabs files from this.state.loadedFiles().
        // If that was empty, we are in trouble.
        if (!oldBook.files || oldBook.files.length === 0) {
            console.warn('[SessionService] Old book files are empty! Attempting to recover from storage/cache if possible?');
            // If really empty, we can't do much but warn.
        }

        await this.storage.saveBook(oldBook);

        // 4. Create NEW Book
        const newBookId = crypto.randomUUID();

        // We do NOT set this.currentBookId directly here.
        // We let loadBook() handle the switch.
        // Also, we do NOT clear this.state.* manually, because unloadCurrentSession already did that or loadBook will do it.
        // If we set currentBookId here, loadBook() will trigger unloadCurrentSession() AGAIN, 
        // which will save the *current empty state* (loadedFiles is empty!) to the NEW book, wiping out the files we are about to save.

        // Copy Files from Old Book

        // Copy Files from Old Book
        // logic reused from loadBook but applied to current 'loadedFiles' which are cleared.
        // We need to reload them from the Old Book data since we unloaded.
        const files = oldBook.files; // These are safe to copy
        // Prompts? 
        const prompts = oldBook.prompts;

        const newBook: Book = {
            id: newBookId,
            name: newNameForNewBook,
            // User didn't specify name for new book, but usually it continues.
            // Let's name it "Act.N+1" for convenience.
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            preview: 'New Chapter',
            messages: [],
            files: files, // COPIED KB
            prompts: prompts,
            stats: {
                tokenUsage: { freshInput: 0, cached: 0, output: 0, total: 0 },
                estimatedCost: 0,
                historyStorageUsage: 0, // Reset for new book
                sunkUsageHistory: [],
                kbStorageUsageAcc: 0,
                kbCacheName: null,
                kbCacheExpireTime: null,
                kbCacheTokens: 0,
                kbCacheHash: null,
                kbSlotId: oldBook.stats.kbSlotId, // Persist Slot ID
                kbSlotName: oldBook.stats.kbSlotName
            }
        };

        await this.storage.saveBook(newBook);

        // Load the new book (rehydrate files)
        await this.loadBook(newBookId);

        // Initialize Story (Start Session)
        // Note: The UI component will handle triggering the actual engine initialization
        // to avoid circular dependencies between SessionService and GameEngineService.
    }

    async deleteBook(id: string) {
        console.log(`[SessionService] Deleting book ${id} `);
        // If it's the current book, unload strictly without saving
        if (this.currentBookId() === id) {
            await this.unloadCurrentSession(false);
        }
        await this.storage.deleteBook(id);
    }

    async nukeAllCaches() {
        return this.cacheManager.clearAllServerCaches();
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
                    return `Act.${actMatch[1]} `;
                }

                // Fallback: 第N章
                const zhMatch = msg.content.match(/第\s*(\d+)\s*章/);
                if (zhMatch) {
                    return `第${zhMatch[1]} 章`;
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
