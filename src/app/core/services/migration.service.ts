import { Injectable, inject } from '@angular/core';
import { StorageService } from './storage.service';
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

    /**
     * Execute all pending migrations.
     * Call this once at application startup.
     */
    async runMigrations(): Promise<void> {
        await this.migrateFilenames();
        // Add future migrations here...
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
