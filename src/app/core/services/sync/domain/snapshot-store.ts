import {
    SyncResource, SnapshotMeta, SnapshotManifest, SnapshotMetaInput,
    SnapshotEntryRef, SnapshotTombstoneRef, SnapshotSkipped, SnapshotLocalPayload,
    Tombstone, RemoteEntry, assertSnapshotId
} from '../sync.types';
import {
    SNAPSHOT_CONCURRENCY, byteLength,
    restampBodyLastActive, dedupeTombstoneArrays, dedupeLocalTombstones,
    diffDeleteTargets, buildManifest,
    SnapshotStoreBackendOps
} from '../sync-snapshot-utils';
import { createParallelPool } from '@app/core/utils/async.util';
import { groupByResource } from '../resource-adapter';
import { SnapshotTreeOps } from './snapshot-tree-ops';

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);

/**
 * Backend-agnostic orchestration of `createSnapshotFrom{Cloud,Local}` and
 * `restoreSnapshot`. The 5-step / 6-step orchestration that previously
 * lived (duplicated) in `s3-snapshot-store.ts`, `gdrive-snapshot-store.ts`,
 * and `file-snapshot-store.ts` is now a single concrete class — backends
 * inject:
 *
 *   - `live: SnapshotStoreBackendOps`   — write to the LIVE tree
 *   - `tree: SnapshotTreeOps`           — IO inside `snapshots/<sid>/...`
 *
 * Concurrency: each parallel pool here uses {@link SNAPSHOT_CONCURRENCY}
 * (8). The pools don't actually contend in practice because the public
 * SyncService.runExclusive serialises sync ops at the call site; the cap
 * just keeps one in-flight pool's worth of round-trips against the
 * browser's connection ceiling.
 *
 * **Cross-device atomicity is NOT guaranteed.** SyncService must quiesce
 * auto-sync before/after restore; otherwise another device pushing in
 * mid-restore can leak its state into the restored result.
 */
export class SnapshotStore {
    constructor(
        private readonly live: SnapshotStoreBackendOps,
        private readonly tree: SnapshotTreeOps
    ) {}

    listSnapshots(): Promise<SnapshotMeta[]> { return this.tree.listSnapshots(); }
    readSnapshotManifest(id: string): Promise<SnapshotManifest> { return this.tree.readManifest(id); }
    deleteSnapshot(id: string): Promise<void> { return this.tree.deleteSnapshotTree(id); }
    updateSnapshotNote(id: string, note: string): Promise<void> { return this.tree.updateNote(id, note); }

    /**
     * Snapshots the current cloud (live) tree into `snapshots/<id>/` via
     * server-side copy where supported. Used for `forcePush` (rescue cloud
     * before overwrite), `manual` (capture the shared cloud state), and
     * `preRestore` (rescue cloud before restore rewrites it).
     *
     * Five steps:
     *   1. Snapshot live state (parallel list + listTombstones for both resources).
     *   2. "Book wins" tombstone dedupe — if an id appears in both live
     *      entries and tombstones, drop the tombstone so restore reflects
     *      the live state at snapshot time.
     *   3. Copy entries (parallel).
     *   4. Copy tombstones (parallel).
     *   5. Build + write manifest.
     */
    async createSnapshotFromCloud(
        snapshotId: string,
        meta: SnapshotMetaInput
    ): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);

        const [books, collections, bookTombs, collTombs] = await Promise.all([
            this.live.list('book'),
            this.live.list('collection'),
            this.live.listTombstones('book'),
            this.live.listTombstones('collection')
        ]);

        const { bookTombs: filteredBookTombs, collTombs: filteredCollTombs } =
            dedupeTombstoneArrays(books, collections, bookTombs, collTombs);

        const skipped: SnapshotSkipped[] = [];

        const bookEntries = await this.copyLiveEntries(snapshotId, 'book', books, skipped);
        const collectionEntries = await this.copyLiveEntries(snapshotId, 'collection', collections, skipped);

        const tombstoneEntries: SnapshotTombstoneRef[] = [];
        const allTombs: { resource: SyncResource; t: Tombstone }[] = [
            ...filteredBookTombs.map(t => ({ resource: 'book' as const, t })),
            ...filteredCollTombs.map(t => ({ resource: 'collection' as const, t }))
        ];
        await parallelPool(allTombs, async ({ resource, t }) => {
            try {
                await this.tree.copyTombstone(snapshotId, resource, t);
                tombstoneEntries.push({ resource, id: t.id, deletedAt: t.deletedAt });
            } catch (e) {
                if (this.isMissingSource(e)) {
                    skipped.push({ resource, id: t.id, reason: 'tombstone source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        const manifest = buildManifest({
            snapshotId, meta, bookEntries, collectionEntries, tombstoneEntries, skipped
        });
        await this.tree.writeManifest(snapshotId, manifest);
        return manifest;
    }

    /**
     * Snapshots a caller-supplied (local IDB) payload into `snapshots/<id>/`
     * by uploading each object directly. Used for `forcePull` — the cloud
     * is about to overwrite local, so the rescue point must mirror local,
     * not cloud. Caller cleans bodies (cleanBookForSync / cleanCollectionForSync)
     * and supplies `lastActiveAt` per entry.
     */
    async createSnapshotFromLocal(
        snapshotId: string,
        meta: SnapshotMetaInput,
        payload: SnapshotLocalPayload
    ): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);

        const filteredTombs = dedupeLocalTombstones(payload);
        const skipped: SnapshotSkipped[] = [];

        const bookEntries: SnapshotEntryRef[] = [];
        await parallelPool(payload.books, async (b) => {
            await this.tree.writeEntry(snapshotId, 'book', b.id, b.json, b.lastActiveAt);
            bookEntries.push({ id: b.id, lastActiveAt: b.lastActiveAt, size: byteLength(b.json) });
        });

        const collectionEntries: SnapshotEntryRef[] = [];
        await parallelPool(payload.collections, async (c) => {
            await this.tree.writeEntry(snapshotId, 'collection', c.id, c.json, c.lastActiveAt);
            collectionEntries.push({ id: c.id, lastActiveAt: c.lastActiveAt, size: byteLength(c.json) });
        });

        const tombstoneEntries: SnapshotTombstoneRef[] = [];
        await parallelPool(filteredTombs, async (t) => {
            await this.tree.writeTombstone(snapshotId, t.resource, t.id, t.deletedAt);
            tombstoneEntries.push({ resource: t.resource, id: t.id, deletedAt: t.deletedAt });
        });

        const manifest = buildManifest({
            snapshotId, meta, bookEntries, collectionEntries, tombstoneEntries, skipped
        });
        await this.tree.writeManifest(snapshotId, manifest);
        return manifest;
    }

    /**
     * Restores live state to match the snapshot's manifest:
     *   - books / collections in manifest are written to live with body
     *     `lastActiveAt` and metadata `last-active` both stamped to
     *     `Date.now()` (defeats newer-wins on other devices and self-heal).
     *   - tombstones in manifest are written with `deletedAt = Date.now()`.
     *   - Live entries not in the manifest are deleted.
     *   - Live tombstones not in the manifest are deleted.
     */
    async restoreSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);

        // 1. Read manifest first. If missing/corrupt, abort without
        //    touching live state.
        const manifest = await this.tree.readManifest(snapshotId);

        // 2. Snapshot live state (taken BEFORE any writes so the diff
        //    can't accidentally include things we just wrote ourselves).
        const [liveBooks, liveCollections, liveBookTombs, liveCollTombs] = await Promise.all([
            this.live.list('book'),
            this.live.list('collection'),
            this.live.listTombstones('book'),
            this.live.listTombstones('collection')
        ]);

        const now = Date.now();

        // 3. Restore entries: read snapshot body, restamp `lastActiveAt`
        //    to now, write to live with metadata `last-active = now`.
        //    Both body and metadata get the new timestamp — body alone
        //    would let self-heal revert via metadata, metadata alone would
        //    let other devices see a stale body and propagate it.
        const restoreItems: { resource: SyncResource; id: string }[] = [
            ...manifest.entries.book.map(e => ({ resource: 'book' as const, id: e.id })),
            ...manifest.entries.collection.map(e => ({ resource: 'collection' as const, id: e.id }))
        ];
        await parallelPool(restoreItems, async (item) => {
            const text = await this.tree.readEntry(snapshotId, item.resource, item.id);
            const restamped = restampBodyLastActive(text, now);
            await this.live.write(item.resource, item.id, restamped, now);
        });

        // 4. Restore tombstones at deletedAt = now. Live writeTombstone
        //    handles "already exists" gracefully on backends that
        //    overwrite (GDrive) or accumulate (S3 / File).
        await parallelPool(manifest.entries.tombstone, async (t) => {
            await this.live.writeTombstone(t.resource, t.id, now);
        });

        // 5. Diff-delete entries.
        const booksToDelete = diffDeleteTargets(liveBooks, manifest.entries.book);
        const collsToDelete = diffDeleteTargets(liveCollections, manifest.entries.collection);
        await parallelPool(booksToDelete, async (b) => this.live.remove('book', b.id));
        await parallelPool(collsToDelete, async (c) => this.live.remove('collection', c.id));

        // 6. Diff-delete tombstones. Anything the manifest doesn't
        //    explicitly mention shouldn't survive in the restored state
        //    (we already wrote fresh tombstones for the manifest's set
        //    in step 4, so an "id in manifest but not in liveBookTombs"
        //    case can't reach delete-by-mistake).
        const manifestTombsByResource = groupByResource(manifest.entries.tombstone);
        const bookTombsToDelete = diffDeleteTargets(liveBookTombs, manifestTombsByResource.book);
        const collTombsToDelete = diffDeleteTargets(liveCollTombs, manifestTombsByResource.collection);
        await parallelPool(bookTombsToDelete, async (t) => this.live.removeTombstone('book', t.id));
        await parallelPool(collTombsToDelete, async (t) => this.live.removeTombstone('collection', t.id));
    }

    /**
     * Copy entries from live into the snapshot tree, swallowing 404s
     * (source disappeared mid-snapshot — common when another device is
     * deleting concurrently). Successful copies and skipped 404s are
     * tracked separately so the manifest faithfully reflects what landed.
     */
    private async copyLiveEntries(
        snapshotId: string,
        resource: SyncResource,
        entries: RemoteEntry[],
        skipped: SnapshotSkipped[]
    ): Promise<SnapshotEntryRef[]> {
        const out: SnapshotEntryRef[] = [];
        await parallelPool(entries, async (e) => {
            try {
                await this.tree.copyEntry(snapshotId, resource, e.id);
                out.push({ id: e.id, lastActiveAt: e.lastActiveAt, etag: e.etag, size: e.size });
            } catch (err) {
                if (this.isMissingSource(err)) {
                    skipped.push({ resource, id: e.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                throw err;
            }
        });
        return out;
    }

    /** Backend-agnostic 404 detector. BlobStore reads throw a generic
     *  Error with "not found" / "404" in the message; we sniff that.
     *  S3 / GDrive native errors hitting BlobStore.copy will surface
     *  the same way after their adapters wrap the SDK exception. */
    private isMissingSource(err: unknown): boolean {
        if (!(err instanceof Error)) return false;
        const msg = err.message.toLowerCase();
        return msg.includes('not found') || msg.includes('404') || msg.includes('nosuchkey');
    }
}
