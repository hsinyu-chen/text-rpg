import {
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotEntryRef,
    SnapshotTombstoneRef, SnapshotSkipped, SnapshotLocalPayload, SyncResource,
    assertSnapshotId
} from './sync.types';
import {
    SNAPSHOT_CONCURRENCY, SNAPSHOT_MANIFEST_NAME,
    byteLength, restampBodyLastActive, dedupeTombstoneArrays,
    dedupeLocalTombstones, diffDeleteTargets,
    buildManifest, manifestToMeta,
    SnapshotStoreBackendOps
} from './sync-snapshot-utils';
import { ensureDir, getDirIfExists, isNotFound, readFileText, splitDir, writeFileText } from './fsa-utils';
import { createParallelPool } from '@app/core/utils/async.util';

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);

const SNAPSHOTS_DIR = 'snapshots';

/**
 * Snapshot CRUD for FileSyncBackend (File System Access). Layout:
 *
 *   <root>/snapshots/<snapshotId>/manifest.json
 *   <root>/snapshots/<snapshotId>/<resource>/<id>.json
 *   <root>/snapshots/<snapshotId>/tombstones/<resource>/<id>__<deletedAt>.json
 *
 * No server-side copy on FSA — create reads each live body and re-writes it
 * into the snapshot subtree. restore mirrors the cloud backends: read body,
 * re-stamp `lastActiveAt = now`, write to live; diff-delete the rest.
 */
export interface FileSnapshotStoreDeps {
    /** Returns the FSA root directory handle. Backend-owned (permission-gated). */
    getRoot(): Promise<FileSystemDirectoryHandle>;
    /** Live-tree subdirectory name per resource (matches backend's RESOURCE_DIR). */
    resourceDir: Record<SyncResource, string>;
    /** Live-tree tombstone path per resource (matches backend's TOMBSTONE_DIR). */
    tombstoneDir: Record<SyncResource, string>;
    ops: SnapshotStoreBackendOps;
}

export class FileSnapshotStore {
    constructor(private readonly deps: FileSnapshotStoreDeps) {}

    private async snapshotsDirIfExists(): Promise<FileSystemDirectoryHandle | null> {
        const root = await this.deps.getRoot();
        return getDirIfExists(root, [SNAPSHOTS_DIR]);
    }

    private async snapshotDirIfExists(snapshotId: string): Promise<FileSystemDirectoryHandle | null> {
        const root = await this.deps.getRoot();
        return getDirIfExists(root, [SNAPSHOTS_DIR, snapshotId]);
    }

    private async ensureSnapshotDir(snapshotId: string): Promise<FileSystemDirectoryHandle> {
        const root = await this.deps.getRoot();
        return ensureDir(root, [SNAPSHOTS_DIR, snapshotId]);
    }

    async listSnapshots(): Promise<SnapshotMeta[]> {
        const dir = await this.snapshotsDirIfExists();
        if (!dir) return [];

        const ids: string[] = [];
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind === 'directory') ids.push(name);
        }

        const metas: (SnapshotMeta | null)[] = new Array(ids.length);
        await parallelPool(ids, async (id, i) => {
            try {
                metas[i] = manifestToMeta(await this.readSnapshotManifest(id));
            } catch (e) {
                console.warn(`[FileBackend] Failed to read snapshot manifest for ${id}; skipping.`, e);
                metas[i] = null;
            }
        });
        return metas.filter((m): m is SnapshotMeta => m !== null);
    }

    async readSnapshotManifest(snapshotId: string): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);
        const dir = await this.snapshotDirIfExists(snapshotId);
        if (!dir) throw new Error(`File: snapshot ${snapshotId} not found`);
        const text = await readFileText(dir, SNAPSHOT_MANIFEST_NAME);
        if (text === null) throw new Error(`File: missing manifest for snapshot ${snapshotId}`);
        return JSON.parse(text) as SnapshotManifest;
    }

    async createSnapshotFromCloud(
        snapshotId: string,
        meta: SnapshotMetaInput
    ): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);

        // 1. Snapshot the live state.
        const [books, collections, bookTombs, collTombs] = await Promise.all([
            this.deps.ops.list('book'),
            this.deps.ops.list('collection'),
            this.deps.ops.listTombstones('book'),
            this.deps.ops.listTombstones('collection')
        ]);

        const { bookTombs: filteredBookTombs, collTombs: filteredCollTombs } =
            dedupeTombstoneArrays(books, collections, bookTombs, collTombs);

        const skipped: SnapshotSkipped[] = [];
        const snapDir = await this.ensureSnapshotDir(snapshotId);
        const booksDir = await ensureDir(snapDir, [this.deps.resourceDir.book]);
        const collsDir = await ensureDir(snapDir, [this.deps.resourceDir.collection]);
        const tombBooksDir = await ensureDir(snapDir, splitDir(this.deps.tombstoneDir.book));
        const tombCollsDir = await ensureDir(snapDir, splitDir(this.deps.tombstoneDir.collection));

        // 2. Read live → write to snapshot subtree (no server-side copy on FSA).
        const bookEntries: SnapshotEntryRef[] = [];
        await parallelPool(books, async (b) => {
            try {
                const text = await readLiveBody(this.deps, 'book', b.id);
                if (text === null) {
                    skipped.push({ resource: 'book', id: b.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                await writeFileText(booksDir, `${b.id}.json`, text);
                bookEntries.push({
                    id: b.id,
                    lastActiveAt: b.lastActiveAt,
                    size: byteLength(text)
                });
            } catch (e) {
                if (isNotFound(e)) {
                    skipped.push({ resource: 'book', id: b.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        const collectionEntries: SnapshotEntryRef[] = [];
        await parallelPool(collections, async (c) => {
            try {
                const text = await readLiveBody(this.deps, 'collection', c.id);
                if (text === null) {
                    skipped.push({ resource: 'collection', id: c.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                await writeFileText(collsDir, `${c.id}.json`, text);
                collectionEntries.push({
                    id: c.id,
                    lastActiveAt: c.lastActiveAt,
                    size: byteLength(text)
                });
            } catch (e) {
                if (isNotFound(e)) {
                    skipped.push({ resource: 'collection', id: c.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        // 3. Tombstones — body is just `{}`, deletedAt is encoded in filename.
        const tombstoneEntries: SnapshotTombstoneRef[] = [];
        await parallelPool(filteredBookTombs, async (t) => {
            await writeFileText(tombBooksDir, `${t.id}__${t.deletedAt}.json`, '{}');
            tombstoneEntries.push({ resource: 'book', id: t.id, deletedAt: t.deletedAt });
        });
        await parallelPool(filteredCollTombs, async (t) => {
            await writeFileText(tombCollsDir, `${t.id}__${t.deletedAt}.json`, '{}');
            tombstoneEntries.push({ resource: 'collection', id: t.id, deletedAt: t.deletedAt });
        });

        const manifest = buildManifest({
            snapshotId, meta, bookEntries, collectionEntries, tombstoneEntries, skipped
        });
        await writeFileText(snapDir, SNAPSHOT_MANIFEST_NAME, JSON.stringify(manifest));
        return manifest;
    }

    async createSnapshotFromLocal(
        snapshotId: string,
        meta: SnapshotMetaInput,
        payload: SnapshotLocalPayload
    ): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);

        const filteredTombs = dedupeLocalTombstones(payload);

        const skipped: SnapshotSkipped[] = [];
        const snapDir = await this.ensureSnapshotDir(snapshotId);
        const booksDir = await ensureDir(snapDir, [this.deps.resourceDir.book]);
        const collsDir = await ensureDir(snapDir, [this.deps.resourceDir.collection]);
        const tombBooksDir = await ensureDir(snapDir, splitDir(this.deps.tombstoneDir.book));
        const tombCollsDir = await ensureDir(snapDir, splitDir(this.deps.tombstoneDir.collection));

        const bookEntries: SnapshotEntryRef[] = [];
        await parallelPool(payload.books, async (b) => {
            await writeFileText(booksDir, `${b.id}.json`, b.json);
            bookEntries.push({
                id: b.id,
                lastActiveAt: b.lastActiveAt,
                size: byteLength(b.json)
            });
        });

        const collectionEntries: SnapshotEntryRef[] = [];
        await parallelPool(payload.collections, async (c) => {
            await writeFileText(collsDir, `${c.id}.json`, c.json);
            collectionEntries.push({
                id: c.id,
                lastActiveAt: c.lastActiveAt,
                size: byteLength(c.json)
            });
        });

        const tombstoneEntries: SnapshotTombstoneRef[] = [];
        await parallelPool(filteredTombs, async (t) => {
            const dir = t.resource === 'book' ? tombBooksDir : tombCollsDir;
            await writeFileText(dir, `${t.id}__${t.deletedAt}.json`, '{}');
            tombstoneEntries.push({ resource: t.resource, id: t.id, deletedAt: t.deletedAt });
        });

        const manifest = buildManifest({
            snapshotId, meta, bookEntries, collectionEntries, tombstoneEntries, skipped
        });
        await writeFileText(snapDir, SNAPSHOT_MANIFEST_NAME, JSON.stringify(manifest));
        return manifest;
    }

    async restoreSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);

        // 1. Read manifest first — abort cleanly if it's missing/corrupt.
        const manifest = await this.readSnapshotManifest(snapshotId);

        // 2. Snapshot live state for diff-delete (BEFORE any writes).
        const [liveBooks, liveCollections] = await Promise.all([
            this.deps.ops.list('book'),
            this.deps.ops.list('collection')
        ]);

        const snapDir = await this.snapshotDirIfExists(snapshotId);
        if (!snapDir) throw new Error(`File: snapshot ${snapshotId} directory missing`);
        const snapBooksDir = await getDirIfExists(snapDir, [this.deps.resourceDir.book]);
        const snapCollsDir = await getDirIfExists(snapDir, [this.deps.resourceDir.collection]);

        const now = Date.now();

        // 3. Re-stamp body lastActiveAt = now and route through ops.write
        //    so any backend-side bookkeeping (e.g. cache state on Drive)
        //    runs identically to a normal upload.
        await parallelPool(manifest.entries.book, async (e) => {
            if (!snapBooksDir) throw new Error(`File: snapshot books dir missing in ${snapshotId}`);
            const text = await readFileText(snapBooksDir, `${e.id}.json`);
            if (text === null) throw new Error(`File: snapshot book body missing for ${e.id}`);
            const restamped = restampBodyLastActive(text, now);
            await this.deps.ops.write('book', e.id, restamped, now);
        });
        await parallelPool(manifest.entries.collection, async (e) => {
            if (!snapCollsDir) throw new Error(`File: snapshot collections dir missing in ${snapshotId}`);
            const text = await readFileText(snapCollsDir, `${e.id}.json`);
            if (text === null) throw new Error(`File: snapshot collection body missing for ${e.id}`);
            const restamped = restampBodyLastActive(text, now);
            await this.deps.ops.write('collection', e.id, restamped, now);
        });

        // 4. Wipe live tombstone trees and re-write at deletedAt = now.
        //    (Same semantics as S3 backend — manifest already deduped.)
        await this.clearLiveTombstones('book');
        await this.clearLiveTombstones('collection');
        await parallelPool(manifest.entries.tombstone, async (t) => {
            await this.deps.ops.writeTombstone(t.resource, t.id, now);
        });

        // 5. Diff-delete: live entries not in manifest.
        const booksToDelete = diffDeleteTargets(liveBooks, manifest.entries.book);
        const collsToDelete = diffDeleteTargets(liveCollections, manifest.entries.collection);
        await parallelPool(booksToDelete, async (b) => this.deps.ops.remove('book', b.id));
        await parallelPool(collsToDelete, async (c) => this.deps.ops.remove('collection', c.id));
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const parent = await this.snapshotsDirIfExists();
        if (!parent) return;
        try {
            await parent.removeEntry(snapshotId, { recursive: true });
        } catch (e) {
            if (isNotFound(e)) return;
            throw e;
        }
    }

    async updateSnapshotNote(snapshotId: string, note: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const dir = await this.snapshotDirIfExists(snapshotId);
        if (!dir) throw new Error(`File: snapshot ${snapshotId} not found`);
        const manifest = await this.readSnapshotManifest(snapshotId);
        manifest.note = note;
        await writeFileText(dir, SNAPSHOT_MANIFEST_NAME, JSON.stringify(manifest));
    }

    /**
     * Wipes the live tombstone subtree by removing the leaf directory and
     * letting writeTombstone() recreate it on next write. Used by restore
     * to clear stale tombstones before applying the manifest's set.
     */
    private async clearLiveTombstones(resource: SyncResource): Promise<void> {
        const root = await this.deps.getRoot();
        const parts = splitDir(this.deps.tombstoneDir[resource]);
        const parent = await getDirIfExists(root, parts.slice(0, -1));
        if (!parent) return;
        try {
            await parent.removeEntry(parts[parts.length - 1], { recursive: true });
        } catch (e) {
            if (isNotFound(e)) return;
            throw e;
        }
    }
}

/**
 * Reads a live entry body via FSA, returning null on file-not-found so the
 * snapshot pipeline can record a `source 404 mid-snapshot` skip rather than
 * aborting. Other read errors propagate.
 *
 * The "resource dir missing" branch (null from getDirIfExists) is
 * unreachable from createSnapshotFromCloud because the immediately-
 * preceding `ops.list(resource)` succeeded; included for defence-in-depth
 * if a future caller invokes this without that precondition.
 */
async function readLiveBody(
    deps: FileSnapshotStoreDeps, resource: SyncResource, id: string
): Promise<string | null> {
    const root = await deps.getRoot();
    const dir = await getDirIfExists(root, [deps.resourceDir[resource]]);
    if (!dir) return null;
    return readFileText(dir, `${id}.json`);
}
