import { Injectable, inject, signal, effect } from '@angular/core';
import { GameStateService } from './game-state.service';
import { BookRepository } from './storage/book.repository';
import { FileRepository } from './storage/file.repository';
import { ChatHistoryRepository } from './storage/chat-history.repository';
import { FileSystemService } from './file-system.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { CacheManagerService } from './cache-manager.service';
import { CostService } from './cost.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SessionSave, Scenario, Book, ROOT_COLLECTION_ID, ChatMessage } from '../models/types';
import { CollectionService } from './collection.service';
import { LastActiveBookStore } from './last-active-book-store';
import { AppConfigStore } from './app-config-store';
import { SessionFileService } from './session-file.service';
import { GAME_INTENTS } from '../constants/game-intents';
import { getCoreFilenames, getSectionHeaders, getUIStrings } from '../constants/engine-protocol';
import { LOCALES } from '../constants/locales';
import { convertLatexToSymbols, repairCorruptedLatex } from '../utils/latex.util';
import { extractActName } from '../utils/act-name.util';

// Pre-feat/correction-string saves stored intent as the raw <XXX> tag and used
// boolean isCorrection. Normalize on load so downstream code only sees the
// current shape. Built dynamically from LOCALES so legacy saves from any
// supported locale (zh-tw <行動意圖>, en <Action>, …) all migrate.
const LEGACY_INTENT_TAG_MAP: Map<string, string> = (() => {
    const m = new Map<string, string>();
    for (const locale of Object.values(LOCALES)) {
        const t = locale.intentTags;
        m.set(t.ACTION, GAME_INTENTS.ACTION);
        m.set(t.FAST_FORWARD, GAME_INTENTS.FAST_FORWARD);
        m.set(t.SYSTEM, GAME_INTENTS.SYSTEM);
        m.set(t.SAVE, GAME_INTENTS.SAVE);
        m.set(t.CONTINUE, GAME_INTENTS.CONTINUE);
    }
    return m;
})();

function migrateIntent(m: ChatMessage): ChatMessage {
    if (!m.intent) return m;
    const canonical = LEGACY_INTENT_TAG_MAP.get(m.intent);
    return canonical ? { ...m, intent: canonical } : m;
}

function migrateLegacyCorrection(raw: ChatMessage & { isCorrection?: boolean }): ChatMessage {
    if (!('isCorrection' in raw)) return raw;
    const m: ChatMessage & { isCorrection?: boolean } = { ...raw };
    if (m.isCorrection && !m.correction) {
        m.correction = '(legacy correction — original note unavailable)';
    }
    delete m.isCorrection;
    return m;
}

@Injectable({
    providedIn: 'root'
})
export class SessionService {
    private state = inject(GameStateService);
    private books = inject(BookRepository);
    private files = inject(FileRepository);
    private chatRepo = inject(ChatHistoryRepository);
    private fileSystem = inject(FileSystemService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private cacheManager = inject(CacheManagerService);
    private costService = inject(CostService);
    private snackBar = inject(MatSnackBar);
    private collections = inject(CollectionService);
    private lastActiveBook = inject(LastActiveBookStore);
    private appConfig = inject(AppConfigStore);
    private sessionFile = inject(SessionFileService);

    constructor() {
        // Only write — removal is handled explicitly in unloadCurrentSession()
        effect(() => {
            const id = this.currentBookId();
            if (id) this.lastActiveBook.set(id);
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
        const lastBookId = this.lastActiveBook.id();
        if (lastBookId) {
            try {
                const book = await this.books.get(lastBookId);
                if (book) {
                    console.log(`[SessionService] Auto-loading last book: ${book.name} (${lastBookId})`);
                    // autoSave=false: boot has no prior active book to save —
                    // loadBook's unloadCurrentSession branch is gated on
                    // currentBookId() anyway, but pass the accurate flag so
                    // the log line doesn't claim AutoSave: true.
                    await this.loadBook(lastBookId, false);
                    return; // loadBook already restored messages
                } else {
                    console.warn(`[SessionService] Last active book ${lastBookId} not found. Clearing.`);
                    this.lastActiveBook.set(null);
                }
            } catch (error) {
                console.error('[SessionService] Failed to auto-load last book', error);
                this.state.status.set('idle');
                this.lastActiveBook.set(null);
            }
        }

        // Fallback: no book to load — restore raw chat history from IDB
        await this.loadHistoryFromStorage();
    }

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
            await this.books.save(newBook);

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
                await this.files.save(filename, content);
                loadedMap.set(filename, content);
            }

            // Update local state and clear history
            this.state.loadedFiles.set(loadedMap);
            this.state.messages.set([]);
            this.state.sunkUsageHistory.set([]); // Reset sunk usage history
            await this.chatRepo.saveMessages([]);
            await this.chatRepo.saveSunkUsage([]); // Clear from IDB
            this.isContextInjected = false;

            // Sync state
            await this.loadFiles(false);

            // Notify success
            const ui = getUIStrings(this.appConfig.outputLanguage());
            this.snackBar.open(ui.GAME_INIT_SUCCESS, 'OK', { duration: 3000 });

            // Note: Caller (GameEngine) still needs to trigger startSession if needed, 
            // but GameEngine.startNewGame previously called startSession.
            // Since startSession is just "local init", we can return true indicating success.
            return true;

        } catch (e) {
            console.error('[SessionService] Failed to initialize new game', e);
            const ui = getUIStrings(this.appConfig.outputLanguage());
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
            await this.chatRepo.deleteAll(); // chat_store
            await this.files.clear(); // file_store

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

            this.lastActiveBook.set(null);
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

        await this.books.save(book);
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
        const activeModelId = this.providerRegistry.getActiveModelId();
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
        const existing = await this.books.get(bookId);

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

        await this.books.save(book);
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
        const book = await this.books.get(id);
        if (!book) {
            throw new Error(`Book ${id} not found!`);
        }

        this.state.status.set('loading');
        try {
            // 3. Rehydrate State
            this.currentBookId.set(book.id);

            // Restore Files
            await this.files.clear();
            const filesMap = new Map<string, string>();
            const tokensMap = new Map<string, number>();

            for (const f of book.files) {
                await this.files.save(f.name, f.content, f.tokens);
                filesMap.set(f.name, f.content);
                if (f.tokens) tokensMap.set(f.name, f.tokens);
            }
            this.state.loadedFiles.set(filesMap);
            this.state.fileTokenCounts.set(tokensMap);

            // Prompts are app-global — they live in prompt_store across all
            // book switches and are no longer carried in the Book payload.

            // Restore Messages
            await this.chatRepo.deleteAll(); // chat_store
            // Repair corrupted LaTeX in existing messages from older sessions
            const repairedMessages = book.messages.map(raw => {
                const m = migrateLegacyCorrection(migrateIntent(raw));
                return {
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
                };
            });
            await this.chatRepo.saveMessages(repairedMessages);
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
                this.cacheManager.startStorageTimer({
                    tokens: stats.kbCacheTokens,
                    expireTime: stats.kbCacheExpireTime ?? null,
                    modelId: this.providerRegistry.getActiveModelId(),
                    cacheName: stats.kbCacheName
                });
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
        const book = await this.books.get(id);
        if (book) {
            book.name = newName.trim();
            // Bump lastActiveAt so cloud sync detects this as a newer record.
            // Without this the rename only persists locally and never reaches
            // the upload phase (localTime stays equal to the previously synced
            // baseline, so the cross-clock newer-than check stays false).
            book.lastActiveAt = Date.now();
            await this.books.save(book);
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
        const oldBook = await this.books.get(currentId);
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

        await this.books.save(oldBook);

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

        await this.books.save(newBook);

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
        const sourceBook = sourceId ? await this.books.get(sourceId) : null;
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

        await this.books.save(newBook);
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
        await this.books.delete(id);
    }

    async nukeAllCaches() {
        const count = await this.cacheManager.clearAllServerCaches();
        // Wipe stale cache metadata from every stored book so the active-cache
        // UI badge stops lying about books whose remote cache is now gone.
        const books = await this.books.list();
        for (const book of books) {
            const s = book.stats;
            if (s.kbCacheName || s.kbCacheExpireTime || s.kbCacheTokens || s.kbCacheHash) {
                s.kbCacheName = null;
                s.kbCacheExpireTime = null;
                s.kbCacheTokens = 0;
                s.kbCacheHash = null;
                await this.books.save(book);
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
        // Restore messages (apply same legacy migrations as the other load paths)
        const migrated = save.messages.map(m => migrateLegacyCorrection(migrateIntent(m)));
        this.state.messages.set(migrated);
        await this.chatRepo.saveMessages(migrated);

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
     * Re-exposed on SessionService since callers (book-list, etc.) reach for it via
     * the session injection.
     */
    extractActName(): string | null {
        return extractActName(this.state.messages());
    }

    /**
     * Bulk imports files into the persistent store (IndexedDB) and reloads the engine state.
     */
    async importFiles(files: Map<string, string>) {
        this.state.status.set('loading');
        try {
            await this.sessionFile.writeFilesToStorage(files);
            await this.loadFiles(false, true);
        } catch (err) {
            console.error('[SessionService] Import failed', err);
            throw err;
        } finally {
            this.state.status.set('idle');
        }
    }

    /**
     * Updates a single file in storage and refreshes the loadedFiles signal.
     * Persists KB change into the active Book LAST so the saved book carries
     * fresh kbCacheHash + nulled kbCacheName + recomputed estimatedKbTokens —
     * otherwise the cloud copy would advertise a cache keyed to the previous
     * content.
     */
    async updateSingleFile(filePath: string, content: string): Promise<void> {
        await this.sessionFile.writeSingleFile(filePath, content);
        console.log('[SessionService] Updated file:', filePath);
        await this.saveCurrentSessionToBook();
    }

    /**
     * Loads files from a directory and initializes the Knowledge Base, then
     * persists into the active Book so cloud sync sees the load. Guarded for
     * the startNewGame path where currentBookId may not be set yet. Callers
     * that re-read files without a real content change (e.g. language
     * toggle) pass bumpTimestamp=false so sync isn't woken up for nothing.
     *
     * The try/catch here is load-bearing: it preserves the original
     * swallow-and-set-error-status contract callers depend on (app.component,
     * config.service, message-state.service don't try/catch this call), AND
     * it gates the Book persistence on a successful load so a half-loaded
     * state never ships to cloud sync.
     */
    async loadFiles(pickFolder = true, bumpTimestamp = false) {
        try {
            await this.sessionFile.loadFilesIntoState(pickFolder);
            if (this.currentBookId()) {
                await this.saveCurrentSessionToBook({ bumpTimestamp });
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
        const saved = await this.chatRepo.getMessages();
        if (saved && Array.isArray(saved)) {
            const migrated = saved.map(m => migrateLegacyCorrection(migrateIntent(m)));
            this.state.messages.set(migrated);
            if (saved.length > 0) {
                this.isContextInjected = true;
            }
        }

        // Restore sunk usage history
        const sunk = await this.chatRepo.getSunkUsage();
        if (Array.isArray(sunk)) {
            this.state.sunkUsageHistory.set(sunk);
        }
    }
}
