import { GoogleDriveService, DriveFile } from '../google-drive.service';
import { KVStore } from '../kv/kv-store';
import {
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotEntryRef,
    SnapshotTombstoneRef, SnapshotSkipped, SnapshotLocalPayload, SyncResource,
    Tombstone, assertSnapshotId
} from './sync.types';
import {
    SNAPSHOT_CONCURRENCY, SNAPSHOT_MANIFEST_NAME,
    byteLength, restampBodyLastActive, dedupeTombstoneArrays,
    buildManifest, manifestToMeta,
    SnapshotStoreBackendOps
} from './sync-snapshot-utils';
import { createParallelPool } from '@app/core/utils/async.util';

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);

const APPDATA_ROOT = 'appDataFolder';
// Snapshot tree uses unprefixed names (no `_v1` legacy carry-over) since
// the snapshots namespace is fresh — there's no existing data to preserve
// folder names for.
const SNAPSHOTS_ROOT_NAME = 'snapshots_root';
const SNAPSHOTS_ROOT_KV_KEY = 'gdrive_snapshots_root_id';
const SNAPSHOT_RESOURCE_FOLDER: Record<SyncResource, string> = {
    book: 'books',
    collection: 'collections'
};
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

// Match the live backend's appProperties keys.
const APP_PROP_LAST_ACTIVE = 'last-active';
const APP_PROP_DELETED_AT = 'deleted-at';

interface SnapshotChildFolders {
    book?: string;
    collection?: string;
}

/**
 * Snapshot CRUD for GDriveSyncBackend. Layout (one self-contained folder
 * per snapshot under snapshots_root):
 *
 *   appDataFolder/snapshots_root/<snapshotId>/manifest.json
 *   appDataFolder/snapshots_root/<snapshotId>/books/<id>.json
 *   appDataFolder/snapshots_root/<snapshotId>/collections/<id>.json
 *   appDataFolder/snapshots_root/<snapshotId>/tombstones_books/<id>     (appProperties.deleted-at)
 *   appDataFolder/snapshots_root/<snapshotId>/tombstones_collections/<id>
 *
 * `snapshots_root` exists as a sibling of the live `books_v1` /
 * `collections` / etc. so snapshot files can never collide with live
 * file ids. The root's Drive id is cached in KVStore; per-snapshot
 * folder ids are NOT cached (each snapshot is single-use).
 */
export interface GDriveSnapshotStoreDeps {
    drive: GoogleDriveService;
    kv: KVStore;
    /** Live tombstone folder names per resource (matches backend's TOMBSTONE_FOLDER_NAME). */
    tombstoneFolderName: Record<SyncResource, string>;
    /** Resolves a live entry's Drive file id (used as CopySource for the snapshot). */
    findLiveFileId(resource: SyncResource, id: string): string | undefined;
    /** Resolves a live tombstone's Drive file id (used as CopySource for the snapshot). */
    findLiveTombstoneFileId(resource: SyncResource, id: string): string | undefined;
    /**
     * Backend-side tombstone delete by id (matches removeTombstoneById on
     * the backend). Used by restore's diff-delete to wipe stale tombstones
     * one at a time without touching the public clearTombstones API
     * (which is reserved for forcePush).
     */
    removeTombstoneById(resource: SyncResource, id: string): Promise<void>;
    ops: SnapshotStoreBackendOps;
}

export class GDriveSnapshotStore {
    private snapshotsRootId: string | null = null;

    constructor(private readonly deps: GDriveSnapshotStoreDeps) {}

    private async ensureSnapshotsRoot(): Promise<string> {
        if (this.snapshotsRootId) return this.snapshotsRootId;

        const stored = this.deps.kv.get(SNAPSHOTS_ROOT_KV_KEY);
        if (stored) {
            this.snapshotsRootId = stored;
            return stored;
        }

        const folders = await this.deps.drive.listFolders(APPDATA_ROOT);
        const found = folders.find(f => f.name === SNAPSHOTS_ROOT_NAME);
        const id = found ? found.id : (await this.deps.drive.createFolder(APPDATA_ROOT, SNAPSHOTS_ROOT_NAME)).id;

        this.snapshotsRootId = id;
        this.deps.kv.set(SNAPSHOTS_ROOT_KV_KEY, id);
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
        const folders = await this.deps.drive.listFolders(root);
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
        const folders = await this.deps.drive.listFolders(snapshotFolderId);
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

    async listSnapshots(): Promise<SnapshotMeta[]> {
        const root = await this.ensureSnapshotsRoot();
        const folders = await this.deps.drive.listFolders(root);
        const metas: (SnapshotMeta | null)[] = new Array(folders.length);
        await parallelPool(folders, async (folder, i) => {
            try {
                const manifest = await this.readSnapshotManifestFromFolder(folder.id, folder.name);
                metas[i] = manifestToMeta(manifest);
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
        const files = await this.deps.drive.listFiles(folderId);
        const manifestFile = files.find(
            f => f.name === SNAPSHOT_MANIFEST_NAME && f.mimeType !== DRIVE_FOLDER_MIME
        );
        if (!manifestFile) {
            throw new Error(`GDrive: manifest.json missing for snapshot ${snapshotIdForError}`);
        }
        const text = await this.deps.drive.readFile(manifestFile.id);
        return JSON.parse(text) as SnapshotManifest;
    }

    async createSnapshotFromCloud(
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
        const snapshotFolder = await this.deps.drive.createFolder(root, snapshotId);
        const [bookFolder, collFolder, bookTombFolder, collTombFolder] = await Promise.all([
            this.deps.drive.createFolder(snapshotFolder.id, SNAPSHOT_RESOURCE_FOLDER.book),
            this.deps.drive.createFolder(snapshotFolder.id, SNAPSHOT_RESOURCE_FOLDER.collection),
            this.deps.drive.createFolder(snapshotFolder.id, this.deps.tombstoneFolderName.book),
            this.deps.drive.createFolder(snapshotFolder.id, this.deps.tombstoneFolderName.collection)
        ]);

        // 2. Snapshot live state. list()/listTombstones() also populate the
        //    backend's fileIdByKey / tombstoneFileIdByKey caches we need
        //    for copyFile lookup.
        const [books, collections, bookTombs, collTombs] = await Promise.all([
            this.deps.ops.list('book'),
            this.deps.ops.list('collection'),
            this.deps.ops.listTombstones('book'),
            this.deps.ops.listTombstones('collection')
        ]);

        // 3. Book-wins dedupe.
        const { bookTombs: filteredBookTombs, collTombs: filteredCollTombs } =
            dedupeTombstoneArrays(books, collections, bookTombs, collTombs);

        const skipped: SnapshotSkipped[] = [];

        // 4. Server-side copy each entry. Drive's files.copy preserves
        //    appProperties (last-active / deleted-at) automatically, so the
        //    snapshot retains the original timestamps.
        // Cache-miss for findLiveFileId / findLiveTombstoneFileId is treated
        // as a programming error (throw), not a transient 404 (skip). The
        // immediately-preceding list()/listTombstones() call populates the
        // cache for every id we're about to iterate, so a miss here means
        // an id appeared in the result but not in the cache — which only
        // happens if the cache logic itself is broken. Real 404s (the
        // source object disappeared between list and copy) surface from
        // copyFile and are caught by isNotFound below.
        const bookEntries: SnapshotEntryRef[] = [];
        await parallelPool(books, async (b) => {
            const fileId = this.deps.findLiveFileId('book', b.id);
            if (!fileId) {
                throw new Error(`GDrive: book/${b.id} listed but not in fileIdByKey cache — list() did not populate as expected`);
            }
            try {
                await this.deps.drive.copyFile(fileId, bookFolder.id, `${b.id}.json`);
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
        await parallelPool(collections, async (c) => {
            const fileId = this.deps.findLiveFileId('collection', c.id);
            if (!fileId) {
                throw new Error(`GDrive: collection/${c.id} listed but not in fileIdByKey cache — list() did not populate as expected`);
            }
            try {
                await this.deps.drive.copyFile(fileId, collFolder.id, `${c.id}.json`);
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
        await parallelPool(allTombs, async ({ resource, t, targetFolder }) => {
            const fileId = this.deps.findLiveTombstoneFileId(resource, t.id);
            if (!fileId) {
                throw new Error(`GDrive: ${resource} tombstone/${t.id} listed but not in tombstoneFileIdByKey cache — listTombstones() did not populate as expected`);
            }
            try {
                // Filename = id (matches live tombstone layout); deletedAt
                // is preserved as appProperty by copyFile.
                await this.deps.drive.copyFile(fileId, targetFolder, t.id);
                tombstoneEntries.push({ resource, id: t.id, deletedAt: t.deletedAt });
            } catch (e) {
                if (this.isNotFound(e)) {
                    skipped.push({ resource, id: t.id, reason: 'tombstone source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        const manifest = buildManifest({
            snapshotId, meta, bookEntries, collectionEntries, tombstoneEntries, skipped
        });
        await this.deps.drive.createFile(snapshotFolder.id, SNAPSHOT_MANIFEST_NAME, JSON.stringify(manifest));
        return manifest;
    }

    async createSnapshotFromLocal(
        snapshotId: string,
        meta: SnapshotMetaInput,
        payload: SnapshotLocalPayload
    ): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);

        const root = await this.ensureSnapshotsRoot();
        const snapshotFolder = await this.deps.drive.createFolder(root, snapshotId);
        const [bookFolder, collFolder, bookTombFolder, collTombFolder] = await Promise.all([
            this.deps.drive.createFolder(snapshotFolder.id, SNAPSHOT_RESOURCE_FOLDER.book),
            this.deps.drive.createFolder(snapshotFolder.id, SNAPSHOT_RESOURCE_FOLDER.collection),
            this.deps.drive.createFolder(snapshotFolder.id, this.deps.tombstoneFolderName.book),
            this.deps.drive.createFolder(snapshotFolder.id, this.deps.tombstoneFolderName.collection)
        ]);

        const bookIds = new Set(payload.books.map(b => b.id));
        const collIds = new Set(payload.collections.map(c => c.id));
        const filteredTombs = payload.tombstones.filter(t => {
            if (t.resource === 'book') return !bookIds.has(t.id);
            return !collIds.has(t.id);
        });

        const skipped: SnapshotSkipped[] = [];

        const bookEntries: SnapshotEntryRef[] = [];
        await parallelPool(payload.books, async (b) => {
            const props = { [APP_PROP_LAST_ACTIVE]: String(b.lastActiveAt) };
            await this.deps.drive.createFile(bookFolder.id, `${b.id}.json`, b.json, props);
            bookEntries.push({
                id: b.id,
                lastActiveAt: b.lastActiveAt,
                size: byteLength(b.json)
            });
        });

        const collectionEntries: SnapshotEntryRef[] = [];
        await parallelPool(payload.collections, async (c) => {
            const props = { [APP_PROP_LAST_ACTIVE]: String(c.lastActiveAt) };
            await this.deps.drive.createFile(collFolder.id, `${c.id}.json`, c.json, props);
            collectionEntries.push({
                id: c.id,
                lastActiveAt: c.lastActiveAt,
                size: byteLength(c.json)
            });
        });

        const tombstoneEntries: SnapshotTombstoneRef[] = [];
        await parallelPool(filteredTombs, async (t) => {
            const props = { [APP_PROP_DELETED_AT]: String(t.deletedAt) };
            const targetFolder = t.resource === 'book' ? bookTombFolder.id : collTombFolder.id;
            await this.deps.drive.createFile(targetFolder, t.id, '', props);
            tombstoneEntries.push({ resource: t.resource, id: t.id, deletedAt: t.deletedAt });
        });

        const manifest = buildManifest({
            snapshotId, meta, bookEntries, collectionEntries, tombstoneEntries, skipped
        });
        await this.deps.drive.createFile(snapshotFolder.id, SNAPSHOT_MANIFEST_NAME, JSON.stringify(manifest));
        return manifest;
    }

    async updateSnapshotNote(snapshotId: string, note: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const folder = await this.findSnapshotFolder(snapshotId);
        if (!folder) throw new Error(`GDrive: snapshot ${snapshotId} not found`);
        const files = await this.deps.drive.listFiles(folder.id);
        const manifestFile = files.find(
            f => f.name === SNAPSHOT_MANIFEST_NAME && f.mimeType !== DRIVE_FOLDER_MIME
        );
        if (!manifestFile) {
            throw new Error(`GDrive: manifest.json missing for snapshot ${snapshotId}`);
        }
        const text = await this.deps.drive.readFile(manifestFile.id);
        const manifest = JSON.parse(text) as SnapshotManifest;
        manifest.note = note;
        await this.deps.drive.updateFile(manifestFile.id, JSON.stringify(manifest));
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
            this.deps.ops.list('book'),
            this.deps.ops.list('collection'),
            this.deps.ops.listTombstones('book'),
            this.deps.ops.listTombstones('collection')
        ]);

        // 3. Resolve snapshot subfolders + their files.
        const subs = await this.getSnapshotChildFolders(snapshotFolder.id);
        const [snapshotBookFiles, snapshotCollFiles] = await Promise.all([
            subs.book ? this.deps.drive.listFiles(subs.book) : Promise.resolve([] as DriveFile[]),
            subs.collection ? this.deps.drive.listFiles(subs.collection) : Promise.resolve([] as DriveFile[])
        ]);
        const bookSrcByName = new Map(snapshotBookFiles.map(f => [f.name, f.id]));
        const collSrcByName = new Map(snapshotCollFiles.map(f => [f.name, f.id]));

        const now = Date.now();

        // 4. Restore books / collections: read snapshot body, restamp body's
        //    lastActiveAt, write to live with appProperties.last-active = now.
        const restoreItems = [
            ...manifest.entries.book.map(e => ({
                id: e.id,
                srcFileId: bookSrcByName.get(`${e.id}.json`),
                resource: 'book' as const
            })),
            ...manifest.entries.collection.map(e => ({
                id: e.id,
                srcFileId: collSrcByName.get(`${e.id}.json`),
                resource: 'collection' as const
            }))
        ];
        await parallelPool(restoreItems, async (item) => {
            if (!item.srcFileId) {
                throw new Error(
                    `GDrive: snapshot ${snapshotId} references ${item.resource}/${item.id} ` +
                    `but the file is missing from the snapshot folder.`
                );
            }
            const text = await this.deps.drive.readFile(item.srcFileId);
            const restamped = restampBodyLastActive(text, now);
            await this.deps.ops.write(item.resource, item.id, restamped, now);
        });

        // 5. Restore tombstones at deletedAt = now. writeTombstone updates
        //    in place if a live tombstone for the same id already exists,
        //    so we don't accumulate stale files for ids that were already
        //    tombstoned.
        await parallelPool(manifest.entries.tombstone, async (t) => {
            await this.deps.ops.writeTombstone(t.resource, t.id, now);
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

        await parallelPool(booksToDelete, async (b) => this.deps.ops.remove('book', b.id));
        await parallelPool(collsToDelete, async (c) => this.deps.ops.remove('collection', c.id));
        await parallelPool(bookTombsToDelete, async (t) => this.deps.removeTombstoneById('book', t.id));
        await parallelPool(collTombsToDelete, async (t) => this.deps.removeTombstoneById('collection', t.id));
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const folder = await this.findSnapshotFolder(snapshotId);
        if (!folder) return; // already gone — no-op
        await this.deps.drive.deleteFolderRecursive(folder.id);
    }
}
