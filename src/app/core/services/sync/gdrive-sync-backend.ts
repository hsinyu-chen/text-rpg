import { Injectable, inject } from '@angular/core';
import { GoogleDriveService } from '../google-drive.service';
import { SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId } from './sync.types';

const APPDATA_ROOT = 'appDataFolder';
const SETTINGS_FILE_NAME = 'settings.json';
const PROMPTS_FILE_NAME = 'prompts.json';
// Match the S3 metadata keys for consistency. Hyphen is fine in Drive's
// appProperties (JSON keys, no header-name restriction).
const APP_PROP_LAST_ACTIVE = 'last-active';
const APP_PROP_DELETED_AT = 'deleted-at';

const FOLDER_NAME: Record<SyncResource, string> = {
    book: 'books_v1',     // legacy folder name preserved for existing data
    collection: 'collections'
};
const TOMBSTONE_FOLDER_NAME: Record<SyncResource, string> = {
    book: 'tombstones_books',
    collection: 'tombstones_collections'
};

@Injectable({ providedIn: 'root' })
export class GDriveSyncBackend implements SyncBackend {
    readonly id: SyncBackendId = 'gdrive';
    readonly label = 'Google Drive';
    readonly supportsBackgroundSync = false;

    private drive = inject(GoogleDriveService);

    private folderIdCache: Partial<Record<SyncResource, string>> = {};
    private tombstoneFolderIdCache: Partial<Record<SyncResource, string>> = {};
    private fileIdByKey = new Map<string, string>();
    private tombstoneFileIdByKey = new Map<string, string>();
    private settingsFileId: string | null = null;
    private promptsFileId: string | null = null;

    get isConfigured(): boolean {
        return this.drive.isConfigured;
    }

    isAuthenticated(): boolean {
        return this.drive.isAuthenticated();
    }

    async authenticate(): Promise<void> {
        await this.drive.login();
    }

    private async ensureFolder(resource: SyncResource): Promise<string> {
        const cached = this.folderIdCache[resource];
        if (cached) return cached;

        const lsKey = `gdrive_folder_${resource}_id`;
        const stored = localStorage.getItem(lsKey);
        if (stored) {
            this.folderIdCache[resource] = stored;
            return stored;
        }

        const folders = await this.drive.listFolders(APPDATA_ROOT);
        const name = FOLDER_NAME[resource];
        const found = folders.find(f => f.name === name);
        const id = found ? found.id : (await this.drive.createFolder(APPDATA_ROOT, name)).id;

        this.folderIdCache[resource] = id;
        localStorage.setItem(lsKey, id);
        return id;
    }

    private async ensureTombstoneFolder(resource: SyncResource): Promise<string> {
        const cached = this.tombstoneFolderIdCache[resource];
        if (cached) return cached;

        const lsKey = `gdrive_tombstone_folder_${resource}_id`;
        const stored = localStorage.getItem(lsKey);
        if (stored) {
            this.tombstoneFolderIdCache[resource] = stored;
            return stored;
        }

        const folders = await this.drive.listFolders(APPDATA_ROOT);
        const name = TOMBSTONE_FOLDER_NAME[resource];
        const found = folders.find(f => f.name === name);
        const id = found ? found.id : (await this.drive.createFolder(APPDATA_ROOT, name)).id;

        this.tombstoneFolderIdCache[resource] = id;
        localStorage.setItem(lsKey, id);
        return id;
    }

    private cacheKey(resource: SyncResource, id: string): string {
        return `${resource}:${id}`;
    }

    async list(resource: SyncResource): Promise<RemoteEntry[]> {
        const folderId = await this.ensureFolder(resource);
        const files = await this.drive.listFiles(folderId);
        const entries: RemoteEntry[] = [];
        for (const f of files) {
            if (!f.name.endsWith('.json')) continue;
            const id = f.name.slice(0, -5);
            this.fileIdByKey.set(this.cacheKey(resource, id), f.id);
            const modifiedAt = f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0;
            const metaValue = f.appProperties?.[APP_PROP_LAST_ACTIVE];
            const lastActiveAt = metaValue ? Number(metaValue) || modifiedAt : modifiedAt;
            entries.push({
                id,
                lastActiveAt,
                modifiedAt,
                size: f.size ? Number(f.size) : undefined,
                etag: f.md5Checksum
            });
        }
        return entries;
    }

    async read(resource: SyncResource, id: string): Promise<string> {
        let fileId = this.fileIdByKey.get(this.cacheKey(resource, id));
        if (!fileId) {
            await this.list(resource);
            fileId = this.fileIdByKey.get(this.cacheKey(resource, id));
        }
        if (!fileId) throw new Error(`Drive: ${resource}/${id} not found.`);
        return this.drive.readFile(fileId);
    }

    async write(resource: SyncResource, id: string, json: string, lastActiveAt: number): Promise<void> {
        const folderId = await this.ensureFolder(resource);
        const key = this.cacheKey(resource, id);
        const existing = this.fileIdByKey.get(key);
        const props = { [APP_PROP_LAST_ACTIVE]: String(lastActiveAt) };
        if (existing) {
            await this.drive.updateFile(existing, json, props);
        } else {
            const created = await this.drive.createFile(folderId, `${id}.json`, json, props);
            this.fileIdByKey.set(key, created.id);
        }
    }

    async remove(resource: SyncResource, id: string): Promise<void> {
        const key = this.cacheKey(resource, id);
        let fileId = this.fileIdByKey.get(key);
        if (!fileId) {
            await this.list(resource);
            fileId = this.fileIdByKey.get(key);
        }
        if (!fileId) return;
        await this.drive.deleteFile(fileId);
        this.fileIdByKey.delete(key);
    }

    async listTombstones(resource: SyncResource): Promise<Tombstone[]> {
        const folderId = await this.ensureTombstoneFolder(resource);
        const files = await this.drive.listFiles(folderId);
        const tombstones: Tombstone[] = [];
        for (const f of files) {
            const id = f.name;
            this.tombstoneFileIdByKey.set(this.cacheKey(resource, id), f.id);
            const modifiedAt = f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0;
            const metaValue = f.appProperties?.[APP_PROP_DELETED_AT];
            const deletedAt = metaValue ? Number(metaValue) || modifiedAt : modifiedAt;
            tombstones.push({ id, deletedAt });
        }
        return tombstones;
    }

    async writeTombstone(resource: SyncResource, id: string, deletedAt: number): Promise<void> {
        const folderId = await this.ensureTombstoneFolder(resource);
        const key = this.cacheKey(resource, id);
        const props = { [APP_PROP_DELETED_AT]: String(deletedAt) };
        const existing = this.tombstoneFileIdByKey.get(key);
        if (existing) {
            await this.drive.updateFile(existing, '', props);
            return;
        }
        const created = await this.drive.createFile(folderId, id, '', props);
        this.tombstoneFileIdByKey.set(key, created.id);
    }

    async clearTombstones(resource: SyncResource): Promise<void> {
        const folderId = await this.ensureTombstoneFolder(resource);
        const files = await this.drive.listFiles(folderId);
        for (const f of files) {
            await this.drive.deleteFile(f.id);
            this.tombstoneFileIdByKey.delete(this.cacheKey(resource, f.name));
        }
    }

    private async findSettingsFileId(): Promise<string | null> {
        if (this.settingsFileId) return this.settingsFileId;
        const files = await this.drive.listFiles(APPDATA_ROOT);
        const file = files.find(f => f.name === SETTINGS_FILE_NAME);
        this.settingsFileId = file?.id ?? null;
        return this.settingsFileId;
    }

    async readSettings(): Promise<string | null> {
        const id = await this.findSettingsFileId();
        if (!id) return null;
        return this.drive.readFile(id);
    }

    async writeSettings(content: string): Promise<void> {
        const id = await this.findSettingsFileId();
        if (id) {
            await this.drive.updateFile(id, content);
            return;
        }
        const created = await this.drive.createFile(APPDATA_ROOT, SETTINGS_FILE_NAME, content);
        this.settingsFileId = created.id;
    }

    private async findPromptsFileId(): Promise<string | null> {
        if (this.promptsFileId) return this.promptsFileId;
        const files = await this.drive.listFiles(APPDATA_ROOT);
        const file = files.find(f => f.name === PROMPTS_FILE_NAME);
        this.promptsFileId = file?.id ?? null;
        return this.promptsFileId;
    }

    async readPrompts(): Promise<string | null> {
        const id = await this.findPromptsFileId();
        if (!id) return null;
        return this.drive.readFile(id);
    }

    async writePrompts(content: string): Promise<void> {
        const id = await this.findPromptsFileId();
        if (id) {
            await this.drive.updateFile(id, content);
            return;
        }
        const created = await this.drive.createFile(APPDATA_ROOT, PROMPTS_FILE_NAME, content);
        this.promptsFileId = created.id;
    }
}
