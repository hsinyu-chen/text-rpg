import { Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
import { SessionService } from './session.service';
import { Book, ChatMessage } from '../models/types';
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
    private session = inject(SessionService);

    /**
     * Execute all pending migrations.
     * Call this once at application startup.
     */
    async runMigrations(): Promise<void> {
        await this.migrateFilenames();
        await this.migrateLegacySession();
        // Add future migrations here...
    }

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
            kbCacheHash: localStorage.getItem('kb_cache_hash'),
            kbStorageUsageAcc: parseFloat(localStorage.getItem('kb_storage_usage_acc') || '0')
        };

        const bookId = crypto.randomUUID();
        const book: Book = {
            id: bookId,
            name: actName,
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
