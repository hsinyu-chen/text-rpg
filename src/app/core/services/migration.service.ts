import { Injectable, inject } from '@angular/core';
import { BookRepository } from './storage/book.repository';
import { FileRepository } from './storage/file.repository';
import { CollectionService } from './collection.service';
import { ROOT_COLLECTION_ID } from '../models/types';
import { FILENAME_MIGRATIONS } from '../constants/migrations';

/**
 * Service to handle data migrations during app startup.
 * Runs once at application initialization.
 */
@Injectable({
    providedIn: 'root'
})
export class MigrationService {
    private books = inject(BookRepository);
    private files = inject(FileRepository);
    private collections = inject(CollectionService);

    async runMigrations(): Promise<void> {
        await this.migrateFilenames();
        await this.migrateBookCollections();
        this.purgeLegacyLocalStorageKeys();
        // Add future migrations here...
    }

    /**
     * Actively wipe localStorage keys that the app no longer reads. Done
     * unconditionally so any stale value from a previous version surfaces
     * as a missing key on the next launch — if anything still depended on
     * it being readable, the failure is loud rather than silent.
     *
     * Intentionally talks to `localStorage` directly instead of going
     * through `KVStore`: these are pre-KVStore legacy keys, and if the
     * KVStore backend ever moves off localStorage this purge must still
     * clean the raw localStorage residue.
     */
     
    private purgeLegacyLocalStorageKeys(): void {
        const keys = [
            // Pre-monorepo LLM provider config (now lives in IDB profiles)
            'llm_provider',
            'gemini_api_key', 'gemini_model_id', 'gemini_enable_cache',
            'gemini_thinking_level_story', 'gemini_thinking_level_general',
            'llama_base_url', 'llama_model_id', 'llama_temperature',
            'llama_frequency_penalty', 'llama_presence_penalty',
            'llama_input_price', 'llama_output_price', 'llama_cached_price',
            'llama_top_p', 'llama_top_k', 'llama_min_p',
            'llama_repetition_penalty', 'llama_enable_thinking',
            'llama_reasoning_effort', 'llama_enable_save_slot',
            'openai_api_key', 'openai_base_url', 'openai_model_id',
            'openai_temperature', 'openai_frequency_penalty',
            'openai_presence_penalty', 'openai_input_price',
            'openai_output_price', 'openai_cached_price',
            // Pre-app_ prefix general settings (consolidated under app_*)
            'gemini_output_language', 'gemini_exchange_rate',
            'gemini_smart_context_turns',
            // Pre-Books single-session state (now per-Book in IDB)
            'estimated_cost', 'history_storage_usage_acc',
            'kb_cache_name', 'kb_cache_expire', 'kb_cache_tokens',
            'kb_cache_hash', 'kb_storage_usage_acc',
            // Defunct global flags
            'enable_dynamic_injection', 'app_enable_cache',
            // Older accumulator keys from pre-Books cost tracking
            'usage_stats', 'storage_cost_acc', 'history_storage_cost_acc',
            'sunk_usage_history',
        ];
        let removed = 0;
        for (const k of keys) {
            // eslint-disable-next-line no-restricted-globals -- see jsdoc on purgeLegacyLocalStorageKeys
            if (localStorage.getItem(k) !== null) {
                // eslint-disable-next-line no-restricted-globals
                localStorage.removeItem(k);
                removed++;
            }
        }
        if (removed > 0) {
            console.log(`[MigrationService] Purged ${removed} legacy localStorage key(s).`);
        }
    }

    /**
     * //MIGRATION CODE START - v3.0 Collections layer
     * Ensures the root Collection exists and assigns 'root' to any Book
     * persisted before the Collection layer was introduced.
     */
    private async migrateBookCollections(): Promise<void> {
        await this.collections.ensureRoot();

        const books = await this.books.list();
        let updated = 0;
        for (const book of books) {
            if (!book.collectionId) {
                book.collectionId = ROOT_COLLECTION_ID;
                await this.books.save(book);
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
     * //MIGRATION CODE START - v1.0 Magic to Magic & Skills rename
     * Migrates old filenames in IndexedDB to new filenames.
     * This handles the 7.魔法.md → 7.魔法與技能.md migration.
     */
    private async migrateFilenames(): Promise<void> {
        for (const [oldName, newName] of Object.entries(FILENAME_MIGRATIONS)) {
            const oldFile = await this.files.get(oldName);
            if (oldFile) {
                // Check if new file already exists
                const newFile = await this.files.get(newName);
                if (!newFile) {
                    // Migrate: save with new name, delete old
                    await this.files.save(newName, oldFile.content, oldFile.tokens);
                    console.log(`[MigrationService] Renamed: ${oldName} → ${newName}`);
                }
                // Always delete old file after migration attempt
                await this.files.delete(oldName);
            }
        }
    }
    // //MIGRATION CODE END
}
