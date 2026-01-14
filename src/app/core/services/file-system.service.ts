import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { FileSystemWindow } from '../models/types';
import { StorageService } from './storage.service';
import { LOCALES } from '../constants/locales';

@Injectable({
    providedIn: 'root'
})
export class FileSystemService {
    directoryHandle = signal<FileSystemDirectoryHandle | null>(null);

    hasHandle = computed(() => !!this.directoryHandle());

    private http = inject(HttpClient);
    private storage = inject(StorageService);


    /**
     * Helper to normalize file content:
     * 1. Remove BOM
     * 2. Convert CRLF to LF
     */
    private normalizeContent(content: string): string {
        return content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    }

    /**
     * Prompts the user to select a directory using the File System Access API.
     * @returns The directory handle of the selected folder.
     */
    async selectDirectory(): Promise<FileSystemDirectoryHandle> {
        try {
            const handle = await (window as unknown as FileSystemWindow).showDirectoryPicker();
            this.directoryHandle.set(handle);
            return handle;
        } catch (err) {
            console.error('Directory selection failed or cancelled', err);
            throw err;
        }
    }

    /**
     * Synchronizes all story files from the selected directory into IndexedDB.
     */
    async syncDiskToDb(): Promise<void> {
        if (!this.directoryHandle()) return;

        // Aggregate known story files from all locales
        const storyFiles = new Set<string>();
        Object.values(LOCALES).forEach(locale => {
            Object.values(locale.coreFilenames).forEach(filename => {
                storyFiles.add(filename);
            });
        });

        await this.storage.clearFiles();
        for (const filename of storyFiles) {
            try {
                const fileHandle = await this.directoryHandle()!.getFileHandle(filename);
                const file = await fileHandle.getFile();
                const rawContent = await file.text();
                const content = this.normalizeContent(rawContent);
                await this.storage.saveFile(filename, content);
            } catch {
                console.warn(`Initial sync: ${filename} not found.`);
            }
        }
    }



    /**
     * Reads the text content of a file within a directory handle.
     * @param handle The directory handle.
     * @param filename The name of the file to read.
     * @returns The file content as a string.
     */
    async readFromDiskHandle(handle: FileSystemDirectoryHandle, filename: string): Promise<string> {
        try {
            const fileHandle = await handle.getFileHandle(filename);
            const file = await fileHandle.getFile();
            const raw = await file.text();
            return this.normalizeContent(raw);
        } catch (err) {
            console.warn(`File ${filename} not found in selected directory.`);
            throw err;
        }
    }

    /**
     * Fetches a file's content from the application's assets or via HTTP.
     * @param path The URL or relative path to the asset.
     * @returns The file content as a string.
     */
    async getFallbackContent(path: string): Promise<string> {
        const cacheBuster = `?t=${Date.now()}`;
        const raw = await firstValueFrom(this.http.get(path + cacheBuster, { responseType: 'text' }));
        return this.normalizeContent(raw);
    }

    /**
     * Loads initial files.
     * Logic: Loads system files from assets, and story files from the selected directory.
     */
    /**
     * Loads system files from assets and story files from the selected directory.
     * @returns A map of file paths to their content strings.
     */
    async loadInitialFiles(): Promise<Map<string, { content: string, tokens?: number }>> {
        const files = new Map<string, { content: string, tokens?: number }>();

        const systemPromptUrl = 'assets/system_files/system_prompt.md';
        const systemPromptKey = 'system_files/system_prompt.md';

        try {
            const assetContent = await this.getFallbackContent(systemPromptUrl);
            const dbEntry = await this.storage.getFile(systemPromptKey);

            // If the fresh asset matches the DB version, we can reuse the cached token count
            if (dbEntry && dbEntry.content === assetContent) { // assetContent is already normalized by getFallbackContent
                files.set(systemPromptKey, { content: assetContent, tokens: dbEntry.tokens });
            } else {
                files.set(systemPromptKey, { content: assetContent });
            }
        } catch (e) {
            console.error('CRITICAL: Failed to load system files from assets', e);
            throw new Error('System files missing in assets.');
        }

        // Load story files from DB
        const dbFiles = await this.storage.getAllFiles();
        if (dbFiles && dbFiles.length > 0) {
            dbFiles.forEach(f => {
                // Story files are everything EXCEPT the system prompt (which we just handled)
                if (f.name !== systemPromptKey) {
                    files.set(f.name, { content: f.content, tokens: f.tokens });
                }
            });
        }

        return files;
    }

    /**
     * Captures a directory handle from the user.
     */
    async getDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
        const handle = await (window as unknown as FileSystemWindow).showDirectoryPicker();
        this.directoryHandle.set(handle);
        return handle;
    }

    /**
     * Compares IndexedDB contents with the physical disk files.
     * @returns A list of files and their difference status.
     */
    async compareStorageToDisk(handle: FileSystemDirectoryHandle): Promise<{ name: string, dbContent: string, diskContent: string, status: 'changed' | 'identical' | 'new_in_db' | 'new_on_disk' }[]> {
        const dbFiles = await this.storage.getAllFiles();
        const results: { name: string, dbContent: string, diskContent: string, status: 'changed' | 'identical' | 'new_in_db' | 'new_on_disk' }[] = [];

        // Aggregate known story files from all locales
        const storyFiles = new Set<string>();
        Object.values(LOCALES).forEach(locale => {
            Object.values(locale.coreFilenames).forEach(filename => {
                storyFiles.add(filename);
            });
        });

        for (const filename of storyFiles) {
            // Strictly exclude system files from the comparison view
            if (filename.startsWith('system_files/') || filename === 'system_prompt.md') {
                continue;
            }

            const dbFile = dbFiles.find(f => f.name === filename);
            let diskContent: string | null = null;
            try {
                const fileHandle = await handle.getFileHandle(filename);
                const file = await fileHandle.getFile();
                diskContent = await file.text();
            } catch {
                diskContent = null;
            }

            const dbContent = dbFile?.content || '';
            const actualDisk = diskContent || '';

            if (dbFile && diskContent !== null) {
                if (dbContent === actualDisk) {
                    results.push({ name: filename, dbContent, diskContent: actualDisk, status: 'identical' });
                } else {
                    results.push({ name: filename, dbContent, diskContent: actualDisk, status: 'changed' });
                }
            } else if (dbFile && diskContent === null) {
                results.push({ name: filename, dbContent, diskContent: '', status: 'new_in_db' });
            } else if (!dbFile && diskContent !== null) {
                results.push({ name: filename, dbContent: '', diskContent: actualDisk, status: 'new_on_disk' });
            }
        }

        return results;
    }

    /**
     * Reads a file. Strictly from DB.
     */
    async readTextFile(filename: string): Promise<string> {
        const fromDb = await this.storage.getFile(filename);
        if (fromDb) return fromDb.content;
        throw new Error(`File ${filename} not found in database.`);
    }

    /**
     * Writes content to a file. Strictly to DB.
     */
    async writeTextFile(filename: string, content: string): Promise<void> {
        await this.storage.saveFile(filename, content);
    }

    /**
     * Low-level write to a directory handle.
     * Used only during manual sync to local disk.
     */
    async writeToDiskHandle(handle: FileSystemDirectoryHandle, filename: string, content: string): Promise<void> {
        try {
            const fileHandle = await handle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(content);
            await writable.close();
        } catch (err) {
            console.error(`Failed to write file ${filename} to disk`, err);
            throw err;
        }
    }

    // ========== Save Slot Management (Local Folder Sync) ==========

    /**
     * Gets or creates the 'saves' subdirectory within the current directory handle.
     */
    async getSaveDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
        if (!this.directoryHandle()) return null;
        try {
            return await this.directoryHandle()!.getDirectoryHandle('saves', { create: true });
        } catch (err) {
            console.error('Failed to get/create saves directory', err);
            return null;
        }
    }

    /**
     * Reads a specific save file.
     */
    async readSaveFile(filename: string): Promise<string> {
        const saveDir = await this.getSaveDirectoryHandle();
        if (!saveDir) throw new Error('Local save directory not available.');
        try {
            const fileHandle = await saveDir.getFileHandle(filename);
            const file = await fileHandle.getFile();
            const raw = await file.text();
            return this.normalizeContent(raw);
        } catch (err) {
            console.error(`Failed to read save ${filename}`, err);
            throw err;
        }
    }

    /**
     * Writes a save file to the 'saves' subdirectory.
     */
    async writeSaveFile(filename: string, content: string): Promise<void> {
        const saveDir = await this.getSaveDirectoryHandle();
        if (!saveDir) throw new Error('Local save directory not available.');
        await this.writeToDiskHandle(saveDir, filename, content);
    }

    /**
     * Lists all .json files in the 'saves' subdirectory with metadata.
     */
    async listLocalSaves(): Promise<{ handle: FileSystemFileHandle, name: string, lastModified: number }[]> {
        const saveDir = await this.getSaveDirectoryHandle();
        if (!saveDir) return [];

        const saves: { handle: FileSystemFileHandle, name: string, lastModified: number }[] = [];
        const dir = saveDir as unknown as { values(): AsyncIterable<FileSystemHandle> };
        for await (const entry of dir.values()) {
            if (entry.kind === 'file' && entry.name.endsWith('.json')) {
                const fileHandle = entry as FileSystemFileHandle;
                const file = await fileHandle.getFile();
                saves.push({
                    handle: fileHandle,
                    name: entry.name,
                    lastModified: file.lastModified
                });
            }
        }
        return saves;
    }

    /**
     * Deletes a save file from the 'saves' subdirectory.
     */
    async deleteFromLocalDisk(name: string): Promise<void> {
        const saveDir = await this.getSaveDirectoryHandle();
        if (!saveDir) return;
        try {
            await saveDir.removeEntry(name);
        } catch (err) {
            console.error(`Failed to delete save ${name} from local disk`, err);
        }
    }
}
