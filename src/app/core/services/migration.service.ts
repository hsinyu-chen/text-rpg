import { Injectable, inject } from '@angular/core';
import { LLMConfig } from '@hcs/llm-core';
import { LLM_STORAGE_TOKEN } from '@hcs/llm-angular-common';
import { StorageService } from './storage.service';
import { SessionService } from './session.service';
import { CollectionService } from './collection.service';
import { Book, ChatMessage, ROOT_COLLECTION_ID } from '../models/types';
import { FILENAME_MIGRATIONS } from '../constants/migrations';

/**
 * Service to handle data migrations during app startup.
 * Runs once at application initialization.
 */
@Injectable({
    providedIn: 'root'
})
export class MigrationService {
    private storage = inject(StorageService);
    private llmStorage = inject(LLM_STORAGE_TOKEN);
    private session = inject(SessionService);
    private collections = inject(CollectionService);

    /**
     * Execute all pending migrations.
     * Call this once at application startup BEFORE LLM providers initialize,
     * so `migrateLLMProfiles` has written any seed profiles into IndexedDB
     * before LLMConfigService does its first read.
     */
    async runMigrations(): Promise<void> {
        await this.migrateFilenames();
        await this.migrateBookCollections();
        await this.migrateLegacySession();
        await this.migrateLLMProfiles();
        // Add future migrations here...
    }

    /**
     * //MIGRATION CODE START - v3.0 Collections layer
     * Ensures the root Collection exists and assigns 'root' to any Book
     * persisted before the Collection layer was introduced.
     */
    private async migrateBookCollections(): Promise<void> {
        await this.collections.ensureRoot();

        const books = await this.storage.getBooks();
        let updated = 0;
        for (const book of books) {
            if (!book.collectionId) {
                book.collectionId = ROOT_COLLECTION_ID;
                await this.storage.saveBook(book);
                updated++;
            }
        }
        if (updated > 0) {
            console.log(`[MigrationService] Backfilled collectionId='root' on ${updated} legacy book(s).`);
        }

        await this.collections.load();
    }
    // //MIGRATION CODE END

    /**
     * //MIGRATION CODE START - v2.0 Monorepo LLM provider swap
     * Seed LLM profile storage from the pre-monorepo per-key layout if and
     * only if the user has no profiles yet AND at least one legacy key is
     * present. Idempotent: the `storage.getAll().length > 0` guard means a
     * user who deletes every profile via the manager will NOT be re-seeded
     * from stale localStorage the next time the app launches.
     */
    private async migrateLLMProfiles(): Promise<void> {
        const existing = await this.llmStorage.getAll();
        if (existing.length > 0) return;

        const seeds = this.buildLegacyProfileSeeds();
        if (seeds.length === 0) {
            console.log('[MigrationService] No legacy LLM config to migrate.');
            return;
        }

        for (const profile of seeds) {
            await this.llmStorage.save(profile);
        }

        // Pick an active profile: honor the legacy `llm_provider` pointer if
        // it matches a seeded provider, otherwise fall back to the first one
        // we produced.
        const legacyActive = localStorage.getItem('llm_provider');
        const chosen = seeds.find(p => p.provider === legacyActive) ?? seeds[0];
        localStorage.setItem('llm_active_profile_id', chosen.id);

        console.log(`[MigrationService] Seeded ${seeds.length} LLM profile(s) from legacy keys. Active: ${chosen.name}`);
    }

    private buildLegacyProfileSeeds(): LLMConfig[] {
        const num = (k: string): number | undefined => {
            const v = localStorage.getItem(k);
            if (v === null || v === '') return undefined;
            const n = parseFloat(v);
            return Number.isFinite(n) ? n : undefined;
        };
        const str = (k: string): string | undefined => {
            const v = localStorage.getItem(k);
            return v === null || v === '' ? undefined : v;
        };
        const bool = (k: string): boolean | undefined => {
            const v = localStorage.getItem(k);
            return v === null ? undefined : v === 'true';
        };

        const seeds: LLMConfig[] = [];

        const geminiKey = localStorage.getItem('gemini_api_key');
        if (geminiKey) {
            seeds.push({
                id: crypto.randomUUID(),
                name: 'Gemini',
                provider: 'gemini',
                settings: {
                    apiKey: geminiKey,
                    modelId: str('gemini_model_id'),
                    additionalSettings: {
                        enableCache: bool('gemini_enable_cache') ?? false,
                        thinkingLevelStory: str('gemini_thinking_level_story') ?? 'minimal',
                        thinkingLevelGeneral: str('gemini_thinking_level_general') ?? 'high'
                    }
                }
            });
        }

        const llamaUrl = localStorage.getItem('llama_base_url');
        if (llamaUrl) {
            seeds.push({
                id: crypto.randomUUID(),
                name: 'llama.cpp',
                provider: 'llama.cpp',
                settings: {
                    baseUrl: llamaUrl,
                    modelId: str('llama_model_id'),
                    temperature: num('llama_temperature'),
                    frequency_penalty: num('llama_frequency_penalty'),
                    presence_penalty: num('llama_presence_penalty'),
                    inputPrice: num('llama_input_price'),
                    outputPrice: num('llama_output_price'),
                    cacheInputPrice: num('llama_cached_price'),
                    additionalSettings: {
                        topP: num('llama_top_p'),
                        topK: num('llama_top_k'),
                        minP: num('llama_min_p'),
                        repetitionPenalty: num('llama_repetition_penalty'),
                        enableThinking: bool('llama_enable_thinking') ?? false,
                        reasoningEffort: str('llama_reasoning_effort') ?? 'low',
                        enableCacheSlot: bool('llama_enable_save_slot') ?? false
                    }
                }
            });
        }

        const openaiKey = localStorage.getItem('openai_api_key');
        if (openaiKey) {
            seeds.push({
                id: crypto.randomUUID(),
                name: 'OpenAI',
                provider: 'openai',
                settings: {
                    apiKey: openaiKey,
                    baseUrl: str('openai_base_url'),
                    modelId: str('openai_model_id'),
                    temperature: num('openai_temperature'),
                    frequency_penalty: num('openai_frequency_penalty'),
                    presence_penalty: num('openai_presence_penalty'),
                    inputPrice: num('openai_input_price'),
                    outputPrice: num('openai_output_price'),
                    cacheInputPrice: num('openai_cached_price'),
                    additionalSettings: {}
                }
            });
        }

        return seeds;
    }
    // //MIGRATION CODE END

    /**
     * //MIGRATION CODE START - v1.3 Multi-Session Support
     * Wraps legacy flat session data into a Book object.
     */
    private async migrateLegacySession(): Promise<void> {
        const books = await this.storage.getBooks();
        if (books.length > 0) return; // Already migrated or started fresh

        // Check if there's any legacy data
        const messages = await this.storage.get<ChatMessage[]>('chat_history');
        const files = await this.storage.getAllFiles();

        if ((!messages || messages.length === 0) && files.length === 0) {
            console.log('[MigrationService] No legacy data to migrate.');
            return;
        }

        console.log('[MigrationService] Migrating legacy session to Book...');

        // Verify if we have a valid last model message for preview
        const lastModelMsg = messages ? [...messages].reverse().find((m: ChatMessage) => m.role === 'model')?.content?.substring(0, 100) || 'Legacy Session' : 'Legacy Session';

        // Use SessionService's extraction logic if possible, or fallback
        // We can't easily use session.extractActName because session state isn't loaded yet.
        // Simple regex here to mimic it for the Migration
        let actName = 'Legacy Adventure';
        if (messages) {
            for (let i = messages.length - 1; i >= 0; i--) {
                const msg = messages[i];
                if (msg.role === 'model' && msg.content) {
                    const actMatch = msg.content.match(/## Act\.(\d+)/i);
                    if (actMatch) { actName = `Act.${actMatch[1]}`; break; }
                    const zhMatch = msg.content.match(/第\s*(\d+)\s*章/);
                    if (zhMatch) { actName = `第${zhMatch[1]}章`; break; }
                }
            }
        }

        const stats = {
            tokenUsage: { freshInput: 0, cached: 0, output: 0, total: 0 },
            estimatedCost: parseFloat(localStorage.getItem('estimated_cost') || '0'),
            historyStorageUsage: parseFloat(localStorage.getItem('history_storage_usage_acc') || '0'),
            sunkUsageHistory: await this.storage.get<{ prompt: number, cached: number, candidates: number }[]>('sunk_usage_history') || [],

            kbCacheName: localStorage.getItem('kb_cache_name'),
            kbCacheExpireTime: localStorage.getItem('kb_cache_expire') ? parseFloat(localStorage.getItem('kb_cache_expire')!) : null,
            kbCacheTokens: parseInt(localStorage.getItem('kb_cache_tokens') || '0'),
            estimatedKbTokens: parseInt(localStorage.getItem('kb_cache_tokens') || '0'), // Initialize from legacy combined key
            kbCacheHash: localStorage.getItem('kb_cache_hash'),
            kbStorageUsageAcc: parseFloat(localStorage.getItem('kb_storage_usage_acc') || '0')
        };

        const bookId = crypto.randomUUID();
        const book: Book = {
            id: bookId,
            name: actName,
            collectionId: ROOT_COLLECTION_ID,
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            preview: lastModelMsg,
            messages: messages || [],
            files: files.map(f => ({ name: f.name, content: f.content, tokens: f.tokens })),
            prompts: {}, // We don't migrate prompts explicitly as they regenerate/load
            stats: stats
        };

        await this.storage.saveBook(book);
        console.log(`[MigrationService] Legacy session migrated to Book: ${book.name} (${book.id})`);

        // "Adopt" this book as current by properly loading it
        try {
            await this.session.loadBook(bookId);
        } catch (e) {
            console.error('[MigrationService] Failed to load migrated book', e);
        }
    }

    /**
     * //MIGRATION CODE START - v1.0 Magic to Magic & Skills rename
     * Migrates old filenames in IndexedDB to new filenames.
     * This handles the 7.魔法.md → 7.魔法與技能.md migration.
     */
    private async migrateFilenames(): Promise<void> {
        for (const [oldName, newName] of Object.entries(FILENAME_MIGRATIONS)) {
            const oldFile = await this.storage.getFile(oldName);
            if (oldFile) {
                // Check if new file already exists
                const newFile = await this.storage.getFile(newName);
                if (!newFile) {
                    // Migrate: save with new name, delete old
                    await this.storage.saveFile(newName, oldFile.content, oldFile.tokens);
                    console.log(`[MigrationService] Renamed: ${oldName} → ${newName}`);
                }
                // Always delete old file after migration attempt
                await this.storage.deleteFile(oldName);
            }
        }
    }
    // //MIGRATION CODE END
}
