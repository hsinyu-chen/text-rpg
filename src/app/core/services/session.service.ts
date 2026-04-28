import { Injectable, inject, signal, effect } from '@angular/core';
import { GameStateService } from './game-state.service';
import { StorageService } from './storage.service';
import { FileSystemService } from './file-system.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMProvider, LLMProviderConfig } from '@hcs/llm-core';
import { CacheManagerService } from './cache-manager.service';
import { CostService } from './cost.service';
import { KnowledgeService } from './knowledge.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SessionSave, Scenario, Book, ROOT_COLLECTION_ID } from '../models/types';
import { CollectionService } from './collection.service';
import { GAME_INTENTS } from '../constants/game-intents';
import { getCoreFilenames, getSectionHeaders, getUIStrings } from '../constants/engine-protocol';
import { LOCALES } from '../constants/locales';
import { InjectionService } from './injection.service';
import { convertLatexToSymbols, repairCorruptedLatex } from '../utils/latex.util';

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
    private collections = inject(CollectionService);

    constructor() {
        // Only write — removal is handled explicitly in unloadCurrentSession()
        effect(() => {
            const id = this.currentBookId();
            if (id) localStorage.setItem('last_active_book_id', id);
        });
    }

    // Signals
    currentBookId = signal<string | null>(null);

    /**
     * Bumped after every successful saveCurrentSessionToBook(). External services
     * (SyncService) listen to this to schedule debounced auto-sync without forming
     * a circular DI dependency back into SessionService.
     */
    lastSavedAt = signal<number>(0);

    /**
     * Initializes the SessionService.
     * Restores the last active book ID to ensure session continuity.
     */
    async init() {
        const lastBookId = localStorage.getItem('last_active_book_id');
        if (lastBookId) {
            try {
                const book = await this.storage.getBook(lastBookId);
                if (book) {
                    console.log(`[SessionService] Auto-loading last book: ${book.name} (${lastBookId})`);
                    await this.loadBook(lastBookId);
                    return; // loadBook already restored messages
                } else {
                    console.warn(`[SessionService] Last active book ${lastBookId} not found. Clearing.`);
                    localStorage.removeItem('last_active_book_id');
                }
            } catch (error) {
                console.error('[SessionService] Failed to auto-load last book', error);
                this.state.status.set('idle');
                localStorage.removeItem('last_active_book_id');
            }
        }

        // Fallback: no book to load — restore raw chat history from IDB
        await this.loadHistoryFromStorage();
    }

    private get provider(): LLMProvider {
        const p = this.providerRegistry.getActive();
        if (!p) throw new Error('No active LLM provider');
        return p;
    }

    private get providerConfig(): LLMProviderConfig {
        return this.providerRegistry.getActiveConfig();
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
        appearance: string
    }, scenario: Scenario) {
        this.state.status.set('generating');
        const scenarioId = scenario.id;
        const scenarioFiles = scenario.files;

        try {
            console.log(`[SessionService] Starting New Game (${scenarioId}) with profile:`, profile);

            // CRITICAL: Clear existing session and files to prevent cross-session pollution
            // Auto-save current if exists, then unload
            await this.unloadCurrentSession(true);

            // Create a Collection for this new game using the rule
            const collection = await this.collections.createForNewGame({ name: profile.name }, scenario);

            // Create a new Book entry under the new Collection
            const newBookId = crypto.randomUUID();
            this.currentBookId.set(newBookId);

            // We don't save the book object immediately here; we just set the ID.
            // The first auto-save or unload will actually write the book to DB.
            // But to ensure it exists in the list, we can create a skeletal one.
            const newBook: Book = {
                id: newBookId,
                name: profile.name || 'New Adventure',
                collectionId: collection.id,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                preview: 'Beginning...',
                messages: [],
                files: [],
                stats: {
                    tokenUsage: { freshInput: 0, cached: 0, output: 0, total: 0 },
                    estimatedCost: 0,
                    historyStorageUsage: 0,
                    sunkUsageHistory: [],
                    kbCacheName: null,
                    kbCacheExpireTime: null,
                    kbCacheTokens: 0,
                    estimatedKbTokens: 0,
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
                        const sceneContent = content.split(startSceneHeader)[1].split(/\n---|\n##/)[0].trim();
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
     * @param save Whether to serialize the current session state to IndexedDB before clearing.
     */
    async unloadCurrentSession(save: boolean) {
        console.log('[SessionService] Unloading current session...', { save });
        this.state.status.set('loading');
        try {
            if (save) {
                // Don't bump lastActiveAt here. The unload path runs whenever a
                // user just opens another book — not because content changed —
                // so a bump would mark the book "newer than baseline" and trip
                // sync into uploading + flagging conflicts on otherwise-stable
                // books. Real edits flow through other saveBook callers that do
                // bump the timestamp.
                await this.saveCurrentSessionToBook({ bumpTimestamp: false });
            }

            // 1. Clear active-session IDB stores. prompt_store is intentionally
            // NOT cleared — prompts are app-global across book switches.
            await this.storage.clear(); // chat_store
            await this.storage.clearFiles(); // file_store

            // 2. Reset all signals and local state
            this.state.messages.set([]);
            this.state.loadedFiles.set(new Map());

            // 3. Reset Cache/Cost signals but DO NOT delete server cache
            // The metadata was saved to the Book in saveCurrentSessionToBook()
            this.cacheManager.resetCacheState(); // This just clears local keys/signals

            this.state.tokenUsage.set({ freshInput: 0, cached: 0, output: 0, total: 0 });
            this.state.estimatedKbTokens.set(0);
            this.state.kbCacheTokens.set(0);
            this.state.lastTurnUsage.set(null);
            this.state.lastTurnCost.set(0);
            this.state.historyStorageUsageAccumulated.set(0);
            this.state.sunkUsageHistory.set([]);
            this.state.storageUsageAccumulated.set(0);

            // Cache signals are cleared by cacheManager.resetCacheState()

            localStorage.removeItem('last_active_book_id');
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
    async startEmptySession(collectionId: string = ROOT_COLLECTION_ID) {
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
            collectionId,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            preview: 'Empty Session',
            messages: [],
            files: [],
            stats: {
                tokenUsage: this.state.tokenUsage(),
                estimatedCost: 0,
                historyStorageUsage: 0,
                sunkUsageHistory: [],
                kbStorageUsageAcc: 0,
                kbCacheName: null,
                kbCacheExpireTime: null,
                kbCacheTokens: 0,
                estimatedKbTokens: 0,
                kbCacheHash: null
            }
        };

        await this.storage.saveBook(book);
        console.log('[SessionService] Started empty session:', bookId);
    }
    async saveCurrentSessionToBook(opts?: { bumpTimestamp?: boolean }) {
        const bumpTimestamp = opts?.bumpTimestamp ?? true;
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

        // Cache Metadata
        const kbCacheName = this.state.kbCacheName();
        const kbCacheExpireTime = this.state.kbCacheExpireTime();
        const kbCacheTokens = this.state.kbCacheTokens();
        const estimatedKbTokens = this.state.estimatedKbTokens();
        const kbCacheHash = this.state.kbCacheHash();

        // Usage Stats
        const tokenUsage = this.state.tokenUsage();
        const historyStorageUsage = this.state.historyStorageUsageAccumulated();
        const sunkUsageHistory = this.state.sunkUsageHistory();
        const kbStorageUsageAcc = this.state.storageUsageAccumulated();

        // Calculate estimated cost dynamically (same as sidebar-cost-prediction)
        const activeProvider = this.providerRegistry.getActive();
        const activeModelId = this.state.config()?.modelId || activeProvider?.getDefaultModelId();
        const model = this.providerRegistry.getActiveModels().find(m => m.id === activeModelId);
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

        // Read existing first so we can preserve identity fields (name, createdAt, collectionId)
        const existing = await this.storage.getBook(bookId);

        const book: Book = {
            id: bookId,
            name: this.state.messages().length > 0 ? (this.extractActName() || 'Untitled Session') : 'Empty Session',
            collectionId: existing?.collectionId || ROOT_COLLECTION_ID,
            createdAt: Date.now(),
            lastActiveAt: bumpTimestamp ? Date.now() : (existing?.lastActiveAt ?? Date.now()),
            preview: lastParams,
            messages: messages.map(m => ({
                ...m,
                content: convertLatexToSymbols(m.content),
                parts: m.parts?.map(p => ({
                    ...p,
                    text: p.text ? convertLatexToSymbols(p.text) : p.text
                })) || []
            })),
            files,
            stats: {
                tokenUsage,
                estimatedCost,
                historyStorageUsage,
                sunkUsageHistory,
                kbCacheName,
                kbCacheExpireTime,
                kbCacheTokens,
                estimatedKbTokens,
                kbCacheHash,
                kbStorageUsageAcc
            }
        };

        if (existing) {
            book.name = existing.name; // Keep user-defined name
            book.createdAt = existing.createdAt;
        }

        await this.storage.saveBook(book);
        this.lastSavedAt.set(Date.now());
        console.log(`[SessionService] Book ${bookId} saved.`);
    }

    /**
     * Loads a Book into the active session.
     * @param id The ID of the book to load.
     * @param autoSave Whether to save the current session before unloading. Set to false when refreshing after cloud sync.
     */
    async loadBook(id: string, autoSave = true) {
        console.log(`[SessionService] Loading Book ${id}... (AutoSave: ${autoSave})`);

        // 1. Unload current
        if (this.currentBookId()) {
            await this.unloadCurrentSession(autoSave);
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

            // Prompts are app-global — they live in prompt_store across all
            // book switches and are no longer carried in the Book payload.

            // Restore Messages
            await this.storage.clear(); // chat_store
            // Repair corrupted LaTeX in existing messages from older sessions
            const repairedMessages = book.messages.map(m => ({
                ...m,
                content: repairCorruptedLatex(m.content),
                thought: m.thought ? repairCorruptedLatex(m.thought) : m.thought,
                analysis: m.analysis ? repairCorruptedLatex(m.analysis) : m.analysis,
                summary: m.summary ? convertLatexToSymbols(m.summary) : m.summary,
                character_log: m.character_log?.map(c => convertLatexToSymbols(c)),
                inventory_log: m.inventory_log?.map(i => convertLatexToSymbols(i)),
                quest_log: m.quest_log?.map(q => convertLatexToSymbols(q)),
                world_log: m.world_log?.map(w => convertLatexToSymbols(w)),
                parts: m.parts?.map(p => ({
                    ...p,
                    text: p.text ? (m.role === 'model' && (p.thought || p.thoughtSignature) ? repairCorruptedLatex(p.text) : convertLatexToSymbols(p.text)) : p.text
                })) || []
            }));
            await this.storage.set('chat_history', repairedMessages);
            this.state.messages.set(repairedMessages);
            if (repairedMessages.length > 0) this.isContextInjected = true;

            // Restore Stats
            this.state.tokenUsage.set(book.stats.tokenUsage);
            this.state.historyStorageUsageAccumulated.set(book.stats.historyStorageUsage);
            this.state.sunkUsageHistory.set(book.stats.sunkUsageHistory);

            // Restore Cost Active Accumulation
            this.state.storageUsageAccumulated.set(book.stats.kbStorageUsageAcc);

            // Restore Cache Metadata
            const stats = book.stats;
            if (stats.kbCacheName) {
                this.state.kbCacheName.set(stats.kbCacheName);
                if (stats.kbCacheExpireTime) this.state.kbCacheExpireTime.set(stats.kbCacheExpireTime);
                this.state.kbCacheTokens.set(stats.kbCacheTokens);
                if (stats.kbCacheHash) this.state.kbCacheHash.set(stats.kbCacheHash);
                const restoredTotal = stats.estimatedKbTokens || Array.from(tokensMap.values()).reduce((a, b) => a + b, 0);
                this.state.estimatedKbTokens.set(restoredTotal);
                this.cacheManager.startStorageTimer();
            } else {
                this.cacheManager.resetCacheState();
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
            // Bump lastActiveAt so cloud sync detects this as a newer record.
            // Without this the rename only persists locally and never reaches
            // the upload phase (localTime stays equal to the previously synced
            // baseline, so the cross-clock newer-than check stays false).
            book.lastActiveAt = Date.now();
            await this.storage.saveBook(book);
        }
    }

    async createNextBook() {
        const currentId = this.currentBookId();
        if (!currentId) return;

        // 1. Determine Naming & State BEFORE Unloading
        const actName = this.extractActName() || 'Act.1';
        let currentActNum = 1;
        const match = actName.match(/Act\.(\d+)/i) || actName.match(/第\s*(\d+)\s*章/);
        if (match) {
            currentActNum = parseInt(match[1]);
        }

        const newNameForOldBook = `Act.${currentActNum}`;
        const newNameForNewBook = `Act.${currentActNum + 1}`;

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
        // Prompts are app-global (stored in prompt_store) — not copied per-book.

        const newBook: Book = {
            id: newBookId,
            name: newNameForNewBook,
            collectionId: oldBook.collectionId, // Inherit collection from previous Act
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            preview: 'New Chapter',
            messages: [],
            files: files, // COPIED KB
            stats: {
                tokenUsage: { freshInput: 0, cached: 0, output: 0, total: 0 },
                estimatedCost: 0,
                historyStorageUsage: 0, // Reset for new book
                sunkUsageHistory: [],
                kbStorageUsageAcc: 0,
                kbCacheName: null,
                kbCacheExpireTime: null,
                kbCacheTokens: 0,
                estimatedKbTokens: 0, // Reset for new book
                kbCacheHash: null
            }
        };

        await this.storage.saveBook(newBook);

        // Load the new book (rehydrate files)
        await this.loadBook(newBookId);

        // Initialize Story (Start Session)
        // Note: The UI component will handle triggering the actual engine initialization
        // to avoid circular dependencies between SessionService and GameEngineService.
    }

    /**
     * Creates a new Book from an arbitrary set of files (e.g. a freshly extracted Scene KB),
     * persists it, and loads it as the active session. Preserves the current KB slot metadata
     * and copies the active 'system_main' prompt so the new book is immediately playable.
     * @returns The new book's id.
     */
    async createSceneBook(name: string, files: Map<string, string>): Promise<string> {
        // Capture the active book's collection BEFORE unloading clears state.
        const sourceId = this.currentBookId();
        const sourceBook = sourceId ? await this.storage.getBook(sourceId) : null;
        const collectionId = sourceBook?.collectionId || ROOT_COLLECTION_ID;

        if (this.currentBookId()) {
            await this.unloadCurrentSession(true);
        }

        const newBookId = crypto.randomUUID();
        const filesArr: { name: string; content: string }[] = [];
        for (const [fileName, content] of files.entries()) {
            filesArr.push({ name: fileName, content });
        }

        // Prompts are app-global; nothing to copy into the new book.

        const newBook: Book = {
            id: newBookId,
            name,
            collectionId,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            preview: 'New Scene',
            messages: [],
            files: filesArr,
            stats: {
                tokenUsage: { freshInput: 0, cached: 0, output: 0, total: 0 },
                estimatedCost: 0,
                historyStorageUsage: 0,
                sunkUsageHistory: [],
                kbStorageUsageAcc: 0,
                kbCacheName: null,
                kbCacheExpireTime: null,
                kbCacheTokens: 0,
                estimatedKbTokens: 0,
                kbCacheHash: null
            }
        };

        await this.storage.saveBook(newBook);
        await this.loadBook(newBookId);

        // Files were saved without token counts; recount now so `Est. Cache Size`
        // and per-file token displays are correct for the new book.
        await this.loadFiles(false);
        await this.saveCurrentSessionToBook();

        return newBookId;
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
        const count = await this.cacheManager.clearAllServerCaches();
        // Wipe stale cache metadata from every stored book so the active-cache
        // UI badge stops lying about books whose remote cache is now gone.
        const books = await this.storage.getBooks();
        for (const book of books) {
            const s = book.stats;
            if (s.kbCacheName || s.kbCacheExpireTime || s.kbCacheTokens || s.kbCacheHash) {
                s.kbCacheName = null;
                s.kbCacheExpireTime = null;
                s.kbCacheTokens = 0;
                s.kbCacheHash = null;
                await this.storage.saveBook(book);
            }
        }
        return count;
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
            messages: msgs.map(m => ({
                ...m,
                content: convertLatexToSymbols(m.content),
                parts: m.parts?.map(p => ({
                    ...p,
                    text: p.text ? convertLatexToSymbols(p.text) : p.text
                })) || []
            })),
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
            const count = await this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts: [{ text: content }] }]);
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

            // Persist KB change into the active Book so cloud sync sees it.
            // Without this, sync compares book.lastActiveAt and never picks up
            // edits that happened outside a turn loop.
            await this.saveCurrentSessionToBook();
        }

        console.log('[SessionService] Updated file:', filePath);

        // 2. Invalidate cache if KB hash changes (immediate UI feedback)
        const currentHash = this.state.currentKbHash();
        if (this.state.kbCacheHash() !== currentHash) {
            console.log('[SessionService] KB Content changed through single update. Invalidating remote state.');
            this.state.kbCacheName.set(null);
            this.state.kbCacheHash.set(currentHash);

            // Also re-calculate total estimated tokens
            const contentMap = this.state.loadedFiles();
            const partsForCount = this.kb.buildKnowledgeBaseParts(contentMap);
            const modelId = this.state.config()?.modelId || this.provider.getDefaultModelId();
            const totalTokenCount = await this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts: partsForCount }]);
            this.state.estimatedKbTokens.set(totalTokenCount);
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
                    const count = await this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts: [{ text: item.content }] }]);
                    tokenMap.set(item.name, count);
                    await this.storage.saveFile(item.name, item.content, count);
                }));
            }

            const mainPrompt = await this.storage.getPrompt('system_main');
            if (mainPrompt) {
                if (mainPrompt.tokens) {
                    tokenMap.set('system_files/system_prompt.md', mainPrompt.tokens);
                } else {
                    const count = await this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts: [{ text: mainPrompt.content }] }]);
                    tokenMap.set('system_files/system_prompt.md', count);
                    await this.storage.savePrompt('system_main', mainPrompt.content, count);
                }
            }
            this.state.fileTokenCounts.set(tokenMap);
            const partsForCount = this.kb.buildKnowledgeBaseParts(contentMap);

            const storedHash = this.state.kbCacheHash();
            const currentHashTmp = this.state.currentKbHash();

            let totalTokenCount = 0;
            if (storedHash === currentHashTmp && this.state.estimatedKbTokens() > 0) {
                totalTokenCount = this.state.estimatedKbTokens();
                console.log('[SessionService] Reusing cached total KB tokens (Est):', totalTokenCount);
            } else {
                totalTokenCount = await this.provider.countTokens(this.providerConfig, modelId, [{ role: 'user', parts: partsForCount }]);
                console.log('[SessionService] Counted new total KB tokens (Est):', totalTokenCount);
            }

            this.state.estimatedKbTokens.set(totalTokenCount);
            console.log('[SessionService] Estimated KB Tokens:', totalTokenCount);

            const currentHash = this.state.currentKbHash();

            const hasKbContent = Array.from(contentMap.keys()).some(path => !path.startsWith('system_files/') && path !== 'system_prompt.md');

            if (hasKbContent) {
                if (this.state.kbCacheHash() !== currentHash) {
                    console.log('[SessionService] KB Content changed. Invalidating remote state.');
                    this.state.kbCacheName.set(null);
                    this.state.kbCacheHash.set(currentHash);
                }

                this.isContextInjected = false;
            }

            // Persist into the active Book so cloud sync sees the load.
            // Guarded for the startNewGame path where currentBookId may not be set yet.
            if (this.currentBookId()) {
                await this.saveCurrentSessionToBook();
            }

            this.state.status.set('idle');
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
