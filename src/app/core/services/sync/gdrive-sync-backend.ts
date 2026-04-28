import { Injectable, inject } from '@angular/core';
import { GoogleDriveService, DriveFile } from '../google-drive.service';
import {
    SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId,
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotEntryRef,
    SnapshotTombstoneRef, SnapshotSkipped, assertSnapshotId
} from './sync.types';

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

// Snapshot tree uses unprefixed names (no `_v1` legacy carry-over) since
// the snapshots namespace is fresh — there's no existing data to preserve
// folder names for.
const SNAPSHOTS_ROOT_NAME = 'snapshots_root';
const SNAPSHOTS_ROOT_LS_KEY = 'gdrive_snapshots_root_id';
const SNAPSHOT_MANIFEST_NAME = 'manifest.json';
const SNAPSHOT_RESOURCE_FOLDER: Record<SyncResource, string> = {
    book: 'books',
    collection: 'collections'
};
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const SNAPSHOT_CONCURRENCY = 8;

interface SnapshotChildFolders {
    book?: string;
    collection?: string;
}

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

    // ===== Snapshots =====================================================
    //
    // Layout (one self-contained folder per snapshot under snapshots_root):
    //   appDataFolder/snapshots_root/<snapshotId>/manifest.json
    //   appDataFolder/snapshots_root/<snapshotId>/books/<id>.json
    //   appDataFolder/snapshots_root/<snapshotId>/collections/<id>.json
    //   appDataFolder/snapshots_root/<snapshotId>/tombstones_books/<id>     (appProperties.deleted-at)
    //   appDataFolder/snapshots_root/<snapshotId>/tombstones_collections/<id>
    //
    // `snapshots_root` exists as a sibling of the live `books_v1` /
    // `collections` / etc. so snapshot files can never collide with live
    // file ids. The root's Drive id is cached in localStorage; per-snapshot
    // folder ids are NOT cached (each snapshot is single-use).

    private snapshotsRootId: string | null = null;

    private async ensureSnapshotsRoot(): Promise<string> {
        if (this.snapshotsRootId) return this.snapshotsRootId;

        const stored = localStorage.getItem(SNAPSHOTS_ROOT_LS_KEY);
        if (stored) {
            this.snapshotsRootId = stored;
            return stored;
        }

        const folders = await this.drive.listFolders(APPDATA_ROOT);
        const found = folders.find(f => f.name === SNAPSHOTS_ROOT_NAME);
        const id = found ? found.id : (await this.drive.createFolder(APPDATA_ROOT, SNAPSHOTS_ROOT_NAME)).id;

        this.snapshotsRootId = id;
        localStorage.setItem(SNAPSHOTS_ROOT_LS_KEY, id);
        return id;
    }

    /**
     * Throws if more than one folder with the given snapshotId exists at
     * the root. Drive permits sibling folders with identical names, so an
     * interrupted createSnapshot retry can leave duplicates behind. Picking
     * "the first match" silently would make read/restore/delete operate on
     * a non-deterministic one of them, and deleteSnapshot would only wipe
     * one of the duplicates. Better to surface the inconsistency loudly so
     * the user can pick a fresh id (or manually clean up).
     */
    private async findSnapshotFolder(snapshotId: string): Promise<DriveFile | null> {
        const root = await this.ensureSnapshotsRoot();
        const folders = await this.drive.listFolders(root);
        const matches = folders.filter(f => f.name === snapshotId);
        if (matches.length > 1) {
            throw new Error(
                `GDrive: snapshot ${snapshotId} has ${matches.length} duplicate folders ` +
                `under snapshots_root. Manual cleanup required.`
            );
        }
        return matches[0] ?? null;
    }

    /**
     * Maps a snapshot folder's `books` / `collections` subfolder ids by
     * name. Restore reads files out of these subfolders to repopulate
     * live; tombstone restoration goes through writeTombstone() which
     * targets the LIVE tombstone folders, not the snapshot's, so the
     * snapshot's tombstone subfolder ids are not exposed here.
     */
    private async getSnapshotChildFolders(
        snapshotFolderId: string
    ): Promise<SnapshotChildFolders> {
        const folders = await this.drive.listFolders(snapshotFolderId);
        const out: SnapshotChildFolders = {};
        for (const f of folders) {
            if (f.name === SNAPSHOT_RESOURCE_FOLDER.book) out.book = f.id;
            else if (f.name === SNAPSHOT_RESOURCE_FOLDER.collection) out.collection = f.id;
        }
        return out;
    }

    private isNotFound(err: unknown): boolean {
        return typeof err === 'object' && err !== null && 'status' in err
            && (err as { status: number }).status === 404;
    }

    private async parallelPool<T>(
        items: T[],
        worker: (item: T, idx: number) => Promise<void>,
        concurrency = SNAPSHOT_CONCURRENCY
    ): Promise<void> {
        if (items.length === 0) return;
        let cursor = 0;
        const runners = Array.from(
            { length: Math.min(concurrency, items.length) },
            async () => {
                while (cursor < items.length) {
                    const i = cursor++;
                    await worker(items[i], i);
                }
            }
        );
        await Promise.all(runners);
    }

    async listSnapshots(): Promise<SnapshotMeta[]> {
        const root = await this.ensureSnapshotsRoot();
        const folders = await this.drive.listFolders(root);
        const metas: (SnapshotMeta | null)[] = new Array(folders.length);
        await this.parallelPool(folders, async (folder, i) => {
            try {
                const manifest = await this.readSnapshotManifestFromFolder(folder.id, folder.name);
                const { entries: _entries, ...meta } = manifest;
                metas[i] = meta;
            } catch (e) {
                console.warn(`[GDrive] Failed to read snapshot manifest for ${folder.name}; skipping.`, e);
                metas[i] = null;
            }
        });
        return metas.filter((m): m is SnapshotMeta => m !== null);
    }

    async readSnapshotManifest(snapshotId: string): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);
        const folder = await this.findSnapshotFolder(snapshotId);
        if (!folder) throw new Error(`GDrive: snapshot ${snapshotId} not found`);
        return this.readSnapshotManifestFromFolder(folder.id, snapshotId);
    }

    private async readSnapshotManifestFromFolder(
        folderId: string, snapshotIdForError: string
    ): Promise<SnapshotManifest> {
        const files = await this.drive.listFiles(folderId);
        const manifestFile = files.find(
            f => f.name === SNAPSHOT_MANIFEST_NAME && f.mimeType !== DRIVE_FOLDER_MIME
        );
        if (!manifestFile) {
            throw new Error(`GDrive: manifest.json missing for snapshot ${snapshotIdForError}`);
        }
        const text = await this.drive.readFile(manifestFile.id);
        return JSON.parse(text) as SnapshotManifest;
    }

    async createSnapshot(
        snapshotId: string,
        meta: SnapshotMetaInput
    ): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);

        // 1. Build the snapshot folder + 4 subfolders. Caller is responsible
        //    for not retrying with the same id; a duplicate-id retry would
        //    create a second top-level folder with the same name (Drive
        //    allows this), and listSnapshots would then report two with
        //    the same id.
        const root = await this.ensureSnapshotsRoot();
        const snapshotFolder = await this.drive.createFolder(root, snapshotId);
        const [bookFolder, collFolder, bookTombFolder, collTombFolder] = await Promise.all([
            this.drive.createFolder(snapshotFolder.id, SNAPSHOT_RESOURCE_FOLDER.book),
            this.drive.createFolder(snapshotFolder.id, SNAPSHOT_RESOURCE_FOLDER.collection),
            this.drive.createFolder(snapshotFolder.id, TOMBSTONE_FOLDER_NAME.book),
            this.drive.createFolder(snapshotFolder.id, TOMBSTONE_FOLDER_NAME.collection)
        ]);

        // 2. Snapshot live state. list()/listTombstones() also populate the
        //    fileIdByKey / tombstoneFileIdByKey caches we need for copyFile.
        const [books, collections, bookTombs, collTombs] = await Promise.all([
            this.list('book'),
            this.list('collection'),
            this.listTombstones('book'),
            this.listTombstones('collection')
        ]);

        // 3. Book-wins dedupe.
        const bookIds = new Set(books.map(b => b.id));
        const collIds = new Set(collections.map(c => c.id));
        const filteredBookTombs = bookTombs.filter(t => !bookIds.has(t.id));
        const filteredCollTombs = collTombs.filter(t => !collIds.has(t.id));

        const skipped: SnapshotSkipped[] = [];

        // 4. Server-side copy each entry. Drive's files.copy preserves
        //    appProperties (last-active / deleted-at) automatically, so the
        //    snapshot retains the original timestamps.
        // Cache-miss for fileIdByKey / tombstoneFileIdByKey is treated as
        // a programming error (throw), not a transient 404 (skip). The
        // immediately-preceding list()/listTombstones() call populates the
        // cache for every id we're about to iterate, so a miss here means
        // an id appeared in the result but not in the cache — which only
        // happens if the cache logic itself is broken. Real 404s (the
        // source object disappeared between list and copy) surface from
        // copyFile and are caught by isNotFound below.
        const bookEntries: SnapshotEntryRef[] = [];
        await this.parallelPool(books, async (b) => {
            const fileId = this.fileIdByKey.get(this.cacheKey('book', b.id));
            if (!fileId) {
                throw new Error(`GDrive: book/${b.id} listed but not in fileIdByKey cache — list() did not populate as expected`);
            }
            try {
                await this.drive.copyFile(fileId, bookFolder.id, `${b.id}.json`);
                bookEntries.push({ id: b.id, lastActiveAt: b.lastActiveAt, etag: b.etag, size: b.size });
            } catch (e) {
                if (this.isNotFound(e)) {
                    skipped.push({ resource: 'book', id: b.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        const collectionEntries: SnapshotEntryRef[] = [];
        await this.parallelPool(collections, async (c) => {
            const fileId = this.fileIdByKey.get(this.cacheKey('collection', c.id));
            if (!fileId) {
                throw new Error(`GDrive: collection/${c.id} listed but not in fileIdByKey cache — list() did not populate as expected`);
            }
            try {
                await this.drive.copyFile(fileId, collFolder.id, `${c.id}.json`);
                collectionEntries.push({ id: c.id, lastActiveAt: c.lastActiveAt, etag: c.etag, size: c.size });
            } catch (e) {
                if (this.isNotFound(e)) {
                    skipped.push({ resource: 'collection', id: c.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        const tombstoneEntries: SnapshotTombstoneRef[] = [];
        const allTombs: { resource: SyncResource; t: Tombstone; targetFolder: string }[] = [
            ...filteredBookTombs.map(t => ({ resource: 'book' as const, t, targetFolder: bookTombFolder.id })),
            ...filteredCollTombs.map(t => ({ resource: 'collection' as const, t, targetFolder: collTombFolder.id }))
        ];
        await this.parallelPool(allTombs, async ({ resource, t, targetFolder }) => {
            const fileId = this.tombstoneFileIdByKey.get(this.cacheKey(resource, t.id));
            if (!fileId) {
                throw new Error(`GDrive: ${resource} tombstone/${t.id} listed but not in tombstoneFileIdByKey cache — listTombstones() did not populate as expected`);
            }
            try {
                // Filename = id (matches live tombstone layout); deletedAt
                // is preserved as appProperty by copyFile.
                await this.drive.copyFile(fileId, targetFolder, t.id);
                tombstoneEntries.push({ resource, id: t.id, deletedAt: t.deletedAt });
            } catch (e) {
                if (this.isNotFound(e)) {
                    skipped.push({ resource, id: t.id, reason: 'tombstone source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        // 5. Build + write manifest from the actual copied entries.
        //    Counts and sizeBytes are derived here; SnapshotMetaInput's
        //    `Pick` excludes them at the type level.
        const sizeBytes = sumSizes(bookEntries) + sumSizes(collectionEntries);
        const manifest: SnapshotManifest = {
            id: snapshotId,
            createdAt: meta.createdAt,
            trigger: meta.trigger,
            note: meta.note,
            deviceId: meta.deviceId,
            bookCount: bookEntries.length,
            collectionCount: collectionEntries.length,
            tombstoneCount: tombstoneEntries.length,
            sizeBytes: sizeBytes > 0 ? sizeBytes : undefined,
            skippedIds: skipped.length > 0 ? skipped : undefined,
            version: 1,
            entries: {
                book: bookEntries,
                collection: collectionEntries,
                tombstone: tombstoneEntries
            }
        };

        await this.drive.createFile(snapshotFolder.id, SNAPSHOT_MANIFEST_NAME, JSON.stringify(manifest));

        return manifest;
    }

    async restoreSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);

        // 1. Read manifest. If this fails, abort without touching live.
        const snapshotFolder = await this.findSnapshotFolder(snapshotId);
        if (!snapshotFolder) throw new Error(`GDrive: snapshot ${snapshotId} not found`);
        const manifest = await this.readSnapshotManifestFromFolder(snapshotFolder.id, snapshotId);

        // 2. Snapshot live state, taken BEFORE any writes so diff-delete
        //    operates on the pre-restore set only.
        const [liveBooks, liveCollections, liveBookTombs, liveCollTombs] = await Promise.all([
            this.list('book'),
            this.list('collection'),
            this.listTombstones('book'),
            this.listTombstones('collection')
        ]);

        // 3. Resolve snapshot subfolders + their files.
        const subs = await this.getSnapshotChildFolders(snapshotFolder.id);
        const [snapshotBookFiles, snapshotCollFiles] = await Promise.all([
            subs.book ? this.drive.listFiles(subs.book) : Promise.resolve([] as DriveFile[]),
            subs.collection ? this.drive.listFiles(subs.collection) : Promise.resolve([] as DriveFile[])
        ]);
        const bookSrcByName = new Map(snapshotBookFiles.map(f => [f.name, f.id]));
        const collSrcByName = new Map(snapshotCollFiles.map(f => [f.name, f.id]));

        const now = Date.now();

        // 4. Restore books / collections: read snapshot body, restamp body's
        //    lastActiveAt, write to live with appProperties.last-active = now.
        const bookRestoreItems = manifest.entries.book.map(e => ({
            id: e.id,
            srcFileId: bookSrcByName.get(`${e.id}.json`),
            resource: 'book' as const
        }));
        const collRestoreItems = manifest.entries.collection.map(e => ({
            id: e.id,
            srcFileId: collSrcByName.get(`${e.id}.json`),
            resource: 'collection' as const
        }));
        await this.parallelPool([...bookRestoreItems, ...collRestoreItems], async (item) => {
            if (!item.srcFileId) {
                throw new Error(
                    `GDrive: snapshot ${snapshotId} references ${item.resource}/${item.id} ` +
                    `but the file is missing from the snapshot folder.`
                );
            }
            const text = await this.drive.readFile(item.srcFileId);
            const restamped = restampBodyLastActive(text, now);
            await this.write(item.resource, item.id, restamped, now);
        });

        // 5. Restore tombstones at deletedAt = now. writeTombstone updates
        //    in place if a live tombstone for the same id already exists,
        //    so we don't accumulate stale files for ids that were already
        //    tombstoned.
        await this.parallelPool(manifest.entries.tombstone, async (t) => {
            await this.writeTombstone(t.resource, t.id, now);
        });

        // 6. Diff-delete. Anything in live but not in the manifest goes.
        const manifestBookIds = new Set(manifest.entries.book.map(e => e.id));
        const manifestCollIds = new Set(manifest.entries.collection.map(e => e.id));
        const manifestTombByResource: Record<SyncResource, Set<string>> = {
            book: new Set(manifest.entries.tombstone.filter(t => t.resource === 'book').map(t => t.id)),
            collection: new Set(manifest.entries.tombstone.filter(t => t.resource === 'collection').map(t => t.id))
        };

        const booksToDelete = liveBooks.filter(b => !manifestBookIds.has(b.id));
        const collsToDelete = liveCollections.filter(c => !manifestCollIds.has(c.id));
        const bookTombsToDelete = liveBookTombs.filter(t => !manifestTombByResource.book.has(t.id));
        const collTombsToDelete = liveCollTombs.filter(t => !manifestTombByResource.collection.has(t.id));

        await this.parallelPool(booksToDelete, async (b) => this.remove('book', b.id));
        await this.parallelPool(collsToDelete, async (c) => this.remove('collection', c.id));
        await this.parallelPool(bookTombsToDelete, async (t) => this.removeTombstoneById('book', t.id));
        await this.parallelPool(collTombsToDelete, async (t) => this.removeTombstoneById('collection', t.id));
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const folder = await this.findSnapshotFolder(snapshotId);
        if (!folder) return; // already gone — no-op
        await this.drive.deleteFolderRecursive(folder.id);
    }

    /**
     * Deletes a tombstone file by id (resource + id → cached file id →
     * delete). Used by restoreSnapshot's diff-delete; the public
     * clearTombstones() wipes ALL tombstones for a resource, which is
     * stronger than what diff-delete needs.
     */
    private async removeTombstoneById(resource: SyncResource, id: string): Promise<void> {
        const key = this.cacheKey(resource, id);
        const fileId = this.tombstoneFileIdByKey.get(key);
        if (!fileId) return;
        await this.drive.deleteFile(fileId);
        this.tombstoneFileIdByKey.delete(key);
    }
}

function sumSizes(entries: SnapshotEntryRef[]): number {
    let total = 0;
    for (const e of entries) {
        if (e.size !== undefined) total += e.size;
    }
    return total;
}

function restampBodyLastActive(text: string, now: number): string {
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            (parsed as Record<string, unknown>)['lastActiveAt'] = now;
            return JSON.stringify(parsed);
        }
    } catch {
        // fall through
    }
    return text;
}
