import {
    SnapshotEntryRef, SnapshotLocalPayload, SnapshotManifest,
    SnapshotMetaInput, SnapshotSkipped, SnapshotTombstoneRef, SyncResource, RemoteEntry, Tombstone
} from './sync.types';

/**
 * Concurrency cap shared by all snapshot stores. The bottleneck is per-object
 * round-trips (HEAD/GET/PUT or Drive REST); 8 keeps the browser's connection
 * pool comfortable on every backend (S3-compatible servers, Drive, FSA).
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
 * at create time so restore behaviour matches the from-local path (which
 * inlines the filter since its tombstones carry the `resource` field).
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
