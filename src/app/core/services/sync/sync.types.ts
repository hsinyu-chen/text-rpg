export type SyncBackendId = 'gdrive' | 's3' | 'file';

export type SyncResource = 'book' | 'collection';

export interface Tombstone {
    id: string;
    /**
     * Device-clock timestamp at which the entity was deleted (set by the
     * device that performed the delete). Compared against `local.lastActiveAt`
     * on every sync to decide whether the local entity should be deleted
     * (tombstone newer) or whether it represents a post-delete edit on
     * another device that should propagate as upload (local newer).
     */
    deletedAt: number;
}

export interface RemoteEntry {
    id: string;
    /**
     * Device-clock `lastActiveAt` recovered from the cloud object's user
     * metadata. **This is the only timestamp the sync decision logic reads.**
     * If the backend has no metadata for this object yet (legacy upload from
     * before this scheme), fall back to `modifiedAt`.
     */
    lastActiveAt: number;
    /** Server-assigned wall-clock time. UI / file-viewer only; never used for sync decisions. */
    modifiedAt: number;
    etag?: string;
    /** Optional byte size of the remote object, when the backend can report it cheaply. */
    size?: number;
}

export interface SyncBackend {
    readonly id: SyncBackendId;
    readonly label: string;
    readonly isConfigured: boolean;
    /**
     * True if the backend can run sync without user interaction (no auth popups,
     * no token refresh prompts). Auto-sync UI should only expose backends with this set.
     */
    readonly supportsBackgroundSync: boolean;

    isAuthenticated(): boolean;
    authenticate(): Promise<void>;

    list(resource: SyncResource): Promise<RemoteEntry[]>;
    read(resource: SyncResource, id: string): Promise<string>;
    /**
     * Persists `json` and stamps `lastActiveAt` into user metadata
     * (`Metadata` on S3, `appProperties` on Drive). The caller passes the
     * device-clock `lastActiveAt` of the body it's uploading; backends just
     * round-trip it.
     */
    write(resource: SyncResource, id: string, json: string, lastActiveAt: number): Promise<void>;
    remove(resource: SyncResource, id: string): Promise<void>;

    /**
     * Tombstone API for cross-device delete propagation. A tombstone is a
     * separate cloud object stamped with `deletedAt`. On sync, listTombstones()
     * lets each device discover entities deleted elsewhere and apply the
     * delete locally. Tombstones are never auto-removed (cheap to keep) so
     * that a long-offline device still gets the message when it comes back.
     */
    listTombstones(resource: SyncResource): Promise<Tombstone[]>;
    writeTombstone(resource: SyncResource, id: string, deletedAt: number): Promise<void>;
    /**
     * Wipes all tombstones for a resource. Only used by Force Push (local
     * is the source of truth; we don't want stale tombstones to come back
     * and delete the entities we just re-uploaded).
     */
    clearTombstones(resource: SyncResource): Promise<void>;

    readSettings(): Promise<string | null>;
    writeSettings(content: string): Promise<void>;
    readPrompts(): Promise<string | null>;
    writePrompts(content: string): Promise<void>;

    // Snapshot primitives — point-in-time backups of books + collections +
    // tombstones (settings/prompts intentionally excluded). See
    // SnapshotManifest for the on-cloud layout. Caller (service layer)
    // generates the snapshotId; backends only consume it. Backends must
    // validate id shape via `assertSnapshotId` before any I/O.
    listSnapshots(): Promise<SnapshotMeta[]>;
    readSnapshotManifest(snapshotId: string): Promise<SnapshotManifest>;
    /**
     * Snapshots the current cloud (live) tree into `snapshots/<id>/` via
     * server-side copy — no body bytes traverse the client. Used for
     * `forcePush` (rescue cloud before overwrite), `manual` (capture the
     * shared cloud state), and `preRestore` (rescue cloud before restore
     * rewrites it).
     */
    createSnapshotFromCloud(snapshotId: string, meta: SnapshotMetaInput): Promise<SnapshotManifest>;
    /**
     * Snapshots a caller-supplied (local IDB) payload into `snapshots/<id>/`
     * by uploading each object directly. Used for `forcePull` — the cloud
     * is about to overwrite local, so the rescue point must mirror local,
     * not cloud. Caller is responsible for cleaning bodies (cleanBookForSync /
     * cleanCollectionForSync) and supplying `lastActiveAt` per entry.
     */
    createSnapshotFromLocal(
        snapshotId: string,
        meta: SnapshotMetaInput,
        payload: SnapshotLocalPayload
    ): Promise<SnapshotManifest>;
    /**
     * Restores live state to match the snapshot's manifest:
     *   - books / collections in manifest are written to live with body
     *     `lastActiveAt` and metadata `last-active` both stamped to
     *     `Date.now()` (defeats newer-wins on other devices and self-heal).
     *   - tombstones in manifest are written with `deletedAt = Date.now()`.
     *   - Live entries not in the manifest are deleted (write-then-diff order).
     *
     * **Cross-device atomicity is NOT guaranteed.** The service layer must
     * quiesce auto-sync before/after restore; otherwise another device
     * pushing in mid-restore can leak its state into the restored result.
     */
    restoreSnapshot(snapshotId: string): Promise<void>;
    deleteSnapshot(snapshotId: string): Promise<void>;
    /**
     * Overwrites the `note` field on an existing snapshot's manifest.json.
     * `note` is metadata only (not part of the historical record), so an
     * in-place rewrite is acceptable here even though manifest entries are
     * otherwise immutable.
     */
    updateSnapshotNote(snapshotId: string, note: string): Promise<void>;
}

export type SnapshotTrigger = 'forcePush' | 'forcePull' | 'manual' | 'preRestore';

export interface SnapshotSkipped {
    resource: SyncResource;
    id: string;
    reason: string;
}

export interface SnapshotMeta {
    id: string;
    /** Device-clock time when caller initiated createSnapshot. */
    createdAt: number;
    trigger: SnapshotTrigger;
    note?: string;
    deviceId?: string;
    // Backend-filled (caller-supplied values are ignored on createSnapshot):
    bookCount: number;
    collectionCount: number;
    tombstoneCount: number;
    sizeBytes?: number;
    /** Entries the backend tried to copy but couldn't (e.g. 404 mid-snapshot). */
    skippedIds?: SnapshotSkipped[];
}

/** What the caller is responsible for filling in createSnapshot. */
export type SnapshotMetaInput = Pick<SnapshotMeta, 'createdAt' | 'trigger' | 'note' | 'deviceId'>;

/**
 * Payload for `createSnapshotFromLocal`. Caller (service layer) reads local
 * IDB, applies the same body cleaning used for upload, and hands over the
 * full set of objects to capture. Backends MUST NOT mutate this payload.
 */
export interface SnapshotLocalEntry {
    id: string;
    /** Device-clock lastActiveAt to stamp on the snapshot object's metadata. */
    lastActiveAt: number;
    /** Already-cleaned JSON body to upload verbatim. */
    json: string;
}

export interface SnapshotLocalTombstone {
    resource: SyncResource;
    id: string;
    deletedAt: number;
}

export interface SnapshotLocalPayload {
    books: SnapshotLocalEntry[];
    collections: SnapshotLocalEntry[];
    tombstones: SnapshotLocalTombstone[];
}

export interface SnapshotEntryRef {
    id: string;
    /** Original device-clock lastActiveAt at snapshot time. NOT createdAt. */
    lastActiveAt: number;
    etag?: string;
    size?: number;
}

export interface SnapshotTombstoneRef {
    resource: SyncResource;
    id: string;
    /** Original deletedAt at snapshot time. */
    deletedAt: number;
}

export interface SnapshotManifest extends SnapshotMeta {
    version: 1;
    entries: {
        book: SnapshotEntryRef[];
        collection: SnapshotEntryRef[];
        /**
         * Already deduped at createSnapshot time: if the same id appears in
         * `book[]` (or `collection[]`), its tombstone is omitted here. The
         * "book wins" rule lives in createSnapshot, not in restoreSnapshot.
         */
        tombstone: SnapshotTombstoneRef[];
    };
}

const SNAPSHOT_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Backends MUST call this on every public snapshot method before touching
 * the cloud. Caller-supplied ids that contain `/` or `..` would otherwise
 * escape the snapshot subtree and corrupt live data.
 */
export function assertSnapshotId(snapshotId: string): void {
    if (!snapshotId || !SNAPSHOT_ID_RE.test(snapshotId)) {
        throw new Error(`Invalid snapshotId: ${JSON.stringify(snapshotId)}. Must match ${SNAPSHOT_ID_RE}.`);
    }
}

export interface S3Config {
    endpoint: string;          // e.g. https://s3.example.com
    region: string;            // e.g. us-east-1, or 'auto'
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix?: string;           // optional path prefix within the bucket
    forcePathStyle?: boolean;  // true for SeaweedFS / MinIO; default true
}
