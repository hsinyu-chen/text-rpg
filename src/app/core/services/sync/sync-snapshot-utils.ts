import {
    SnapshotEntryRef, SnapshotLocalPayload, SnapshotManifest,
    SnapshotMetaInput, SnapshotSkipped, SnapshotTombstoneRef, SyncResource, RemoteEntry, Tombstone
} from './sync.types';

/**
 * Concurrency cap reused by every snapshot store and the backends' own
 * list() hydration pools. Each call site builds its own `parallelPool(8)`
 * — they don't actually contend in practice because SyncService.runExclusive
 * serialises sync ops, and the cap is sized for one in-flight pool's worth
 * of round-trips against the browser connection pool.
 */
export const SNAPSHOT_CONCURRENCY = 8;

export const SNAPSHOT_MANIFEST_NAME = 'manifest.json';

export function byteLength(s: string): number {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return s.length;
}

export function sumSizes(items: SnapshotEntryRef[]): number {
    let total = 0;
    for (const e of items) {
        if (e.size !== undefined) total += e.size;
    }
    return total;
}

/**
 * Replaces the body's `lastActiveAt` field with the restore timestamp.
 *
 * If the JSON parse fails (corrupt snapshot body) or the field isn't there,
 * the body is returned unchanged so restore at least preserves the snapshot's
 * data verbatim. Sync-decision logic still has metadata `last-active=now` to
 * work from on cloud backends, and FileBackend's list() falls back to mtime.
 */
export function restampBodyLastActive(text: string, now: number): string {
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

/**
 * "Book wins" dedupe for from-cloud snapshot paths: if an id appears in
 * both the live entries and the tombstones, drop the tombstone. Applied
 * at create time so restore behaviour matches the from-local path.
 */
export function dedupeTombstoneArrays(
    books: RemoteEntry[],
    collections: RemoteEntry[],
    bookTombs: Tombstone[],
    collTombs: Tombstone[]
): { bookTombs: Tombstone[]; collTombs: Tombstone[] } {
    const bookIds = new Set(books.map(b => b.id));
    const collIds = new Set(collections.map(c => c.id));
    return {
        bookTombs: bookTombs.filter(t => !bookIds.has(t.id)),
        collTombs: collTombs.filter(t => !collIds.has(t.id))
    };
}

/**
 * "Book wins" dedupe for from-local snapshot paths. Local-payload
 * tombstones carry the `resource` field, so the filter dispatches per
 * resource on the same input array (vs `dedupeTombstoneArrays` which gets
 * tombstones split by resource on the from-cloud path).
 */
export function dedupeLocalTombstones(
    payload: SnapshotLocalPayload
): SnapshotLocalPayload['tombstones'] {
    const idsByResource: Record<SyncResource, Set<string>> = {
        book: new Set(payload.books.map(b => b.id)),
        collection: new Set(payload.collections.map(c => c.id))
    };
    return payload.tombstones.filter(t => !idsByResource[t.resource].has(t.id));
}

/**
 * Restore's diff-delete target picker: returns live entries (or
 * tombstones) whose ids are NOT in the manifest. Used by every backend
 * to compute the "delete me" set before re-applying the manifest.
 */
export function diffDeleteTargets<T extends { id: string }, M extends { id: string }>(
    live: T[], manifestEntries: M[]
): T[] {
    const ids = new Set(manifestEntries.map(e => e.id));
    return live.filter(item => !ids.has(item.id));
}

export interface BuildManifestArgs {
    snapshotId: string;
    meta: SnapshotMetaInput;
    bookEntries: SnapshotEntryRef[];
    collectionEntries: SnapshotEntryRef[];
    tombstoneEntries: SnapshotTombstoneRef[];
    skipped: SnapshotSkipped[];
}

export function buildManifest(args: BuildManifestArgs): SnapshotManifest {
    const { snapshotId, meta, bookEntries, collectionEntries, tombstoneEntries, skipped } = args;

    // Entries arrive in completion order from the parallel pool, which means
    // the same input set produces a different manifest each run. Sort by id
    // (resource+id for tombstones / skipped) so snapshots are reproducible
    // and byte-comparable across devices for debugging.
    const sortById = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    const sortByResId = (
        a: { resource: SyncResource; id: string },
        b: { resource: SyncResource; id: string }
    ) => (a.resource + '/' + a.id).localeCompare(b.resource + '/' + b.id);
    bookEntries.sort(sortById);
    collectionEntries.sort(sortById);
    tombstoneEntries.sort(sortByResId);
    skipped.sort(sortByResId);

    const sizeBytes = sumSizes(bookEntries) + sumSizes(collectionEntries);
    return {
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
}

/**
 * Strips the heavy `entries` array off a manifest for `listSnapshots()`,
 * which only needs the meta header per row.
 */
export function manifestToMeta(manifest: SnapshotManifest): import('./sync.types').SnapshotMeta {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { entries: _drop, version: _v, ...meta } = manifest;
    return meta;
}

/**
 * Subset of SyncBackend ops a SnapshotStore needs during create/restore so
 * it doesn't have to re-implement live-tree CRUD. Backends pass `this` (or
 * a thin object) when constructing their store.
 */
export interface SnapshotStoreBackendOps {
    list(resource: SyncResource): Promise<RemoteEntry[]>;
    listTombstones(resource: SyncResource): Promise<Tombstone[]>;
    write(resource: SyncResource, id: string, json: string, lastActiveAt: number): Promise<void>;
    writeTombstone(resource: SyncResource, id: string, deletedAt: number): Promise<void>;
    remove(resource: SyncResource, id: string): Promise<void>;
}

export type { SnapshotLocalPayload };
