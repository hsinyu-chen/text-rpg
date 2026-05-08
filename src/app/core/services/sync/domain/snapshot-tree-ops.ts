import { SyncResource, SnapshotMeta, SnapshotManifest, Tombstone } from '../sync.types';

/**
 * Backend-specific operations on the snapshot subtree (everything under
 * `snapshots/<sid>/...`). Lives behind an interface so {@link SnapshotStore}
 * can drive the 5-step orchestration without knowing which backend it's
 * talking to. {@link BlobSnapshotTreeOps} is the single concrete impl that
 * works on any {@link BlobStore}; per-backend subclasses are unnecessary
 * because the snapshot tree shape is uniform once layered over a BlobStore.
 *
 * `SnapshotTreeOps` is paired with `SnapshotStoreBackendOps`
 * (sync-snapshot-utils.ts) — the latter writes to the LIVE tree
 * (`SnapshotStore.restoreSnapshot` uses both).
 */
export interface SnapshotTreeOps {
    /** Lists snapshots' meta headers (no entry data). Returns empty when
     *  no snapshots exist. */
    listSnapshots(): Promise<SnapshotMeta[]>;
    readManifest(snapshotId: string): Promise<SnapshotManifest>;
    writeManifest(snapshotId: string, manifest: SnapshotManifest): Promise<void>;
    updateNote(snapshotId: string, note: string): Promise<void>;
    /** Removes the entire snapshot subtree. No-op if the snapshot doesn't exist. */
    deleteSnapshotTree(snapshotId: string): Promise<void>;

    /**
     * Server-side copies a live entry's body and metadata into the
     * snapshot tree. The snapshot retains the original `last-active`,
     * making the snapshot a faithful historical artefact even after
     * restore re-stamps the live copy.
     *
     * Throws on cache miss / source-missing if the layout requires
     * client-side reads. S3-style backends use CopyObject and never throw
     * for cache misses.
     */
    copyEntry(snapshotId: string, resource: SyncResource, id: string): Promise<void>;
    copyTombstone(snapshotId: string, resource: SyncResource, tomb: Tombstone): Promise<void>;
    /** Writes a fresh entry body + last-active into the snapshot tree
     *  (used by `createSnapshotFromLocal`, where there's no live source
     *  to copy from). */
    writeEntry(
        snapshotId: string, resource: SyncResource, id: string,
        json: string, lastActiveAt: number
    ): Promise<void>;
    writeTombstone(
        snapshotId: string, resource: SyncResource, id: string, deletedAt: number
    ): Promise<void>;
    /** Reads the body of a snapshot entry. Used by `restoreSnapshot`
     *  to read snapshot bodies before restamping and writing them live. */
    readEntry(snapshotId: string, resource: SyncResource, id: string): Promise<string>;
}
