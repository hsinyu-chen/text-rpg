import type { S3Client } from '@aws-sdk/client-s3';
import {
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotEntryRef,
    SnapshotTombstoneRef, SnapshotSkipped, SnapshotLocalPayload, SyncResource, Tombstone,
    assertSnapshotId
} from './sync.types';
import {
    SNAPSHOT_CONCURRENCY, SNAPSHOT_MANIFEST_NAME,
    byteLength, restampBodyLastActive, dedupeTombstoneArrays,
    buildManifest, manifestToMeta,
    SnapshotStoreBackendOps
} from './sync-snapshot-utils';
import { createParallelPool } from '@app/core/utils/async.util';

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);
const SNAPSHOTS_DIR = 'snapshots';

// Match the metadata key the live backend stamps via `last-active` so
// restore can re-stamp without translating between key shapes.
const META_LAST_ACTIVE = 'last-active';

type AwsSdk = typeof import('@aws-sdk/client-s3');

/**
 * Snapshot CRUD for S3SyncBackend. Layout (mirrors the live tree, scoped
 * to a snapshot id):
 *
 *   <prefix>snapshots/<snapshotId>/manifest.json
 *   <prefix>snapshots/<snapshotId>/books/<id>.json
 *   <prefix>snapshots/<snapshotId>/collections/<id>.json
 *   <prefix>snapshots/<snapshotId>/tombstones/books/<id>/<deletedAt>
 *   <prefix>snapshots/<snapshotId>/tombstones/collections/<id>/<deletedAt>
 *
 * Snapshot objects retain the original `last-active` user metadata
 * (CopyObject MetadataDirective: 'COPY'), so the snapshot is a true
 * historical artefact. Restore reads the snapshot body, re-stamps
 * `lastActiveAt` to Date.now() in BOTH body and metadata, and writes back
 * to live — that's what defeats newer-wins on other devices and self-heal
 * trying to revert the body.
 */
export interface S3SnapshotStoreDeps {
    /** Live S3 client + SDK. Owned by the backend; store reads, never destroys. */
    getClient(): S3Client;
    getSdk(): AwsSdk;
    getBucket(): string;
    /** Bucket-level prefix (already trailing-slashed). */
    getPrefix(): string;
    resourceDir: Record<SyncResource, string>;
    tombstoneDir: Record<SyncResource, string>;
    /** Live-tree key for an entry — same shape backend uses for read/write. */
    keyFor(resource: SyncResource, id: string): string;
    /** Live-tree key for a tombstone — same shape backend uses for writeTombstone. */
    tombstoneKey(resource: SyncResource, id: string, deletedAt: number): string;
    /** Backend's S3-specific NoSuchKey/404 detector. */
    isNotFound(err: unknown): boolean;
    ops: SnapshotStoreBackendOps;
}

export class S3SnapshotStore {
    constructor(private readonly deps: S3SnapshotStoreDeps) {}

    private snapshotPrefix(snapshotId: string): string {
        return `${this.deps.getPrefix()}${SNAPSHOTS_DIR}/${snapshotId}/`;
    }

    private snapshotManifestKey(snapshotId: string): string {
        return `${this.snapshotPrefix(snapshotId)}${SNAPSHOT_MANIFEST_NAME}`;
    }

    private snapshotResourceKey(snapshotId: string, resource: SyncResource, id: string): string {
        return `${this.snapshotPrefix(snapshotId)}${this.deps.resourceDir[resource]}/${id}.json`;
    }

    private snapshotTombstoneKey(
        snapshotId: string, resource: SyncResource, id: string, deletedAt: number
    ): string {
        return `${this.snapshotPrefix(snapshotId)}${this.deps.tombstoneDir[resource]}/${id}/${deletedAt}`;
    }

    /**
     * Builds the `CopySource` value for CopyObjectCommand.
     *
     * Format is `bucket-name/key-name`, where the key has each path segment
     * URI-encoded but the slashes preserved. encodeURIComponent on the whole
     * key would encode `/` to `%2F` and break the path; encoding nothing
     * would break on keys with spaces or special chars.
     */
    private encodeCopySource(key: string): string {
        const encodedKey = key.split('/').map(encodeURIComponent).join('/');
        return `${this.deps.getBucket()}/${encodedKey}`;
    }

    async listSnapshots(): Promise<SnapshotMeta[]> {
        const client = this.deps.getClient();
        const sdk = this.deps.getSdk();
        const dirPrefix = `${this.deps.getPrefix()}${SNAPSHOTS_DIR}/`;
        const snapshotIds: string[] = [];
        let continuationToken: string | undefined;
        do {
            const res = await client.send(new sdk.ListObjectsV2Command({
                Bucket: this.deps.getBucket(),
                Prefix: dirPrefix,
                Delimiter: '/',
                ContinuationToken: continuationToken
            }));
            for (const cp of res.CommonPrefixes ?? []) {
                if (!cp.Prefix) continue;
                // CommonPrefix is `<prefix>snapshots/<id>/`. Strip both ends.
                const id = cp.Prefix.slice(dirPrefix.length, -1);
                if (id) snapshotIds.push(id);
            }
            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);

        const metas: (SnapshotMeta | null)[] = new Array(snapshotIds.length);
        await parallelPool(snapshotIds, async (id, i) => {
            try {
                metas[i] = manifestToMeta(await this.readSnapshotManifest(id));
            } catch (e) {
                // Skip unreadable snapshots (corrupt manifest, partial create
                // that never wrote manifest, etc.) rather than failing the
                // whole list — UI can still show the rest.
                console.warn(`[S3] Failed to read snapshot manifest for ${id}; skipping.`, e);
                metas[i] = null;
            }
        });
        return metas.filter((m): m is SnapshotMeta => m !== null);
    }

    async readSnapshotManifest(snapshotId: string): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);
        const client = this.deps.getClient();
        const sdk = this.deps.getSdk();
        const res = await client.send(new sdk.GetObjectCommand({
            Bucket: this.deps.getBucket(),
            Key: this.snapshotManifestKey(snapshotId),
            ResponseCacheControl: 'no-store'
        }));
        if (!res.Body) throw new Error(`S3: empty manifest for snapshot ${snapshotId}`);
        const text = await res.Body.transformToString();
        return JSON.parse(text) as SnapshotManifest;
    }

    async createSnapshotFromCloud(
        snapshotId: string,
        meta: SnapshotMetaInput
    ): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);
        const client = this.deps.getClient();
        const sdk = this.deps.getSdk();
        const bucket = this.deps.getBucket();

        // 1. Snapshot the live state (parallel; each call is independently paginated).
        const [books, collections, bookTombs, collTombs] = await Promise.all([
            this.deps.ops.list('book'),
            this.deps.ops.list('collection'),
            this.deps.ops.listTombstones('book'),
            this.deps.ops.listTombstones('collection')
        ]);

        // 2. Book-wins dedupe.
        const { bookTombs: filteredBookTombs, collTombs: filteredCollTombs } =
            dedupeTombstoneArrays(books, collections, bookTombs, collTombs);

        const skipped: SnapshotSkipped[] = [];

        // 3. Copy books / collections (server-side; preserves last-active metadata).
        const bookEntries: SnapshotEntryRef[] = [];
        await parallelPool(books, async (b) => {
            const src = this.deps.keyFor('book', b.id);
            const dst = this.snapshotResourceKey(snapshotId, 'book', b.id);
            try {
                await client.send(new sdk.CopyObjectCommand({
                    Bucket: bucket,
                    CopySource: this.encodeCopySource(src),
                    Key: dst,
                    MetadataDirective: 'COPY'
                }));
                bookEntries.push({ id: b.id, lastActiveAt: b.lastActiveAt, etag: b.etag, size: b.size });
            } catch (e) {
                if (this.deps.isNotFound(e)) {
                    skipped.push({ resource: 'book', id: b.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        const collectionEntries: SnapshotEntryRef[] = [];
        await parallelPool(collections, async (c) => {
            const src = this.deps.keyFor('collection', c.id);
            const dst = this.snapshotResourceKey(snapshotId, 'collection', c.id);
            try {
                await client.send(new sdk.CopyObjectCommand({
                    Bucket: bucket,
                    CopySource: this.encodeCopySource(src),
                    Key: dst,
                    MetadataDirective: 'COPY'
                }));
                collectionEntries.push({ id: c.id, lastActiveAt: c.lastActiveAt, etag: c.etag, size: c.size });
            } catch (e) {
                if (this.deps.isNotFound(e)) {
                    skipped.push({ resource: 'collection', id: c.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        // 4. Copy tombstones. The deletedAt is encoded in the live key; the
        //    snapshot keeps the same encoding so listTombstones() over the
        //    snapshot tree (if ever needed) would behave identically.
        const tombstoneEntries: SnapshotTombstoneRef[] = [];
        const allTombs: { resource: SyncResource; t: Tombstone }[] = [
            ...filteredBookTombs.map(t => ({ resource: 'book' as const, t })),
            ...filteredCollTombs.map(t => ({ resource: 'collection' as const, t }))
        ];
        await parallelPool(allTombs, async ({ resource, t }) => {
            const src = this.deps.tombstoneKey(resource, t.id, t.deletedAt);
            const dst = this.snapshotTombstoneKey(snapshotId, resource, t.id, t.deletedAt);
            try {
                await client.send(new sdk.CopyObjectCommand({
                    Bucket: bucket,
                    CopySource: this.encodeCopySource(src),
                    Key: dst,
                    MetadataDirective: 'COPY'
                }));
                tombstoneEntries.push({ resource, id: t.id, deletedAt: t.deletedAt });
            } catch (e) {
                if (this.deps.isNotFound(e)) {
                    skipped.push({ resource, id: t.id, reason: 'tombstone source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        const manifest = buildManifest({
            snapshotId, meta, bookEntries, collectionEntries, tombstoneEntries, skipped
        });
        await client.send(new sdk.PutObjectCommand({
            Bucket: bucket,
            Key: this.snapshotManifestKey(snapshotId),
            Body: JSON.stringify(manifest),
            ContentType: 'application/json'
        }));
        return manifest;
    }

    async createSnapshotFromLocal(
        snapshotId: string,
        meta: SnapshotMetaInput,
        payload: SnapshotLocalPayload
    ): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);
        const client = this.deps.getClient();
        const sdk = this.deps.getSdk();
        const bucket = this.deps.getBucket();

        const bookIds = new Set(payload.books.map(b => b.id));
        const collIds = new Set(payload.collections.map(c => c.id));
        const filteredTombs = payload.tombstones.filter(t => {
            if (t.resource === 'book') return !bookIds.has(t.id);
            return !collIds.has(t.id);
        });

        const skipped: SnapshotSkipped[] = [];

        const bookEntries: SnapshotEntryRef[] = [];
        await parallelPool(payload.books, async (b) => {
            const dst = this.snapshotResourceKey(snapshotId, 'book', b.id);
            try {
                await client.send(new sdk.PutObjectCommand({
                    Bucket: bucket,
                    Key: dst,
                    Body: b.json,
                    ContentType: 'application/json',
                    Metadata: { [META_LAST_ACTIVE]: String(b.lastActiveAt) }
                }));
                bookEntries.push({
                    id: b.id,
                    lastActiveAt: b.lastActiveAt,
                    size: byteLength(b.json)
                });
            } catch (e) {
                throw new Error(`S3: failed to upload local snapshot book ${b.id}: ${(e as Error).message}`);
            }
        });

        const collectionEntries: SnapshotEntryRef[] = [];
        await parallelPool(payload.collections, async (c) => {
            const dst = this.snapshotResourceKey(snapshotId, 'collection', c.id);
            try {
                await client.send(new sdk.PutObjectCommand({
                    Bucket: bucket,
                    Key: dst,
                    Body: c.json,
                    ContentType: 'application/json',
                    Metadata: { [META_LAST_ACTIVE]: String(c.lastActiveAt) }
                }));
                collectionEntries.push({
                    id: c.id,
                    lastActiveAt: c.lastActiveAt,
                    size: byteLength(c.json)
                });
            } catch (e) {
                throw new Error(`S3: failed to upload local snapshot collection ${c.id}: ${(e as Error).message}`);
            }
        });

        const tombstoneEntries: SnapshotTombstoneRef[] = [];
        await parallelPool(filteredTombs, async (t) => {
            const dst = this.snapshotTombstoneKey(snapshotId, t.resource, t.id, t.deletedAt);
            try {
                await client.send(new sdk.PutObjectCommand({
                    Bucket: bucket,
                    Key: dst,
                    Body: '',
                    ContentType: 'application/octet-stream'
                }));
                tombstoneEntries.push({ resource: t.resource, id: t.id, deletedAt: t.deletedAt });
            } catch (e) {
                throw new Error(`S3: failed to upload local snapshot tombstone ${t.resource}/${t.id}: ${(e as Error).message}`);
            }
        });

        const manifest = buildManifest({
            snapshotId, meta, bookEntries, collectionEntries, tombstoneEntries, skipped
        });
        await client.send(new sdk.PutObjectCommand({
            Bucket: bucket,
            Key: this.snapshotManifestKey(snapshotId),
            Body: JSON.stringify(manifest),
            ContentType: 'application/json'
        }));
        return manifest;
    }

    async updateSnapshotNote(snapshotId: string, note: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const client = this.deps.getClient();
        const sdk = this.deps.getSdk();
        const manifest = await this.readSnapshotManifest(snapshotId);
        manifest.note = note;
        await client.send(new sdk.PutObjectCommand({
            Bucket: this.deps.getBucket(),
            Key: this.snapshotManifestKey(snapshotId),
            Body: JSON.stringify(manifest),
            ContentType: 'application/json'
        }));
    }

    async restoreSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const client = this.deps.getClient();
        const sdk = this.deps.getSdk();
        const bucket = this.deps.getBucket();

        // 1. Read manifest first. If this fails, abort without touching live.
        const manifest = await this.readSnapshotManifest(snapshotId);

        // 2. Snapshot live state (for diff-delete). Take this BEFORE any
        //    writes so the diff can't accidentally include things we just
        //    wrote ourselves.
        const [liveBooks, liveCollections, liveBookTombs, liveCollTombs] = await Promise.all([
            this.deps.ops.list('book'),
            this.deps.ops.list('collection'),
            this.listTombstoneKeys('book'),
            this.listTombstoneKeys('collection')
        ]);

        const now = Date.now();

        // 3. Write entries from manifest. GET snapshot body, re-stamp body's
        //    lastActiveAt to now, PUT to live with metadata last-active=now.
        //    Both body and metadata get the new timestamp — body alone would
        //    let self-heal revert via metadata, metadata alone would let
        //    other devices see a stale body and propagate it.
        const restoreItems = [
            ...manifest.entries.book.map(e => ({
                id: e.id,
                srcKey: this.snapshotResourceKey(snapshotId, 'book', e.id),
                dstResource: 'book' as const
            })),
            ...manifest.entries.collection.map(e => ({
                id: e.id,
                srcKey: this.snapshotResourceKey(snapshotId, 'collection', e.id),
                dstResource: 'collection' as const
            }))
        ];
        await parallelPool(restoreItems, async (item) => {
            const get = await client.send(new sdk.GetObjectCommand({
                Bucket: bucket,
                Key: item.srcKey,
                ResponseCacheControl: 'no-store'
            }));
            if (!get.Body) {
                throw new Error(`S3: empty body for snapshot entry ${item.dstResource}/${item.id}`);
            }
            const text = await get.Body.transformToString();
            const restamped = restampBodyLastActive(text, now);
            await this.deps.ops.write(item.dstResource, item.id, restamped, now);
        });

        // 4. Write tombstones from manifest at NEW deletedAt. The new
        //    deletedAt path is `<prefix>tombstones/<resource>/<id>/<now>`,
        //    distinct from any older `<id>/<oldDeletedAt>` keys — those
        //    older keys are wiped in the diff-delete phase.
        await parallelPool(manifest.entries.tombstone, async (t) => {
            await this.deps.ops.writeTombstone(t.resource, t.id, now);
        });

        // 5. Diff-delete. live = manifest after this step.
        const manifestBookIds = new Set(manifest.entries.book.map(e => e.id));
        const manifestCollIds = new Set(manifest.entries.collection.map(e => e.id));
        const booksToDelete = liveBooks.filter(b => !manifestBookIds.has(b.id));
        const collsToDelete = liveCollections.filter(c => !manifestCollIds.has(c.id));
        await parallelPool(booksToDelete, async (b) => this.deps.ops.remove('book', b.id));
        await parallelPool(collsToDelete, async (c) => this.deps.ops.remove('collection', c.id));

        // For tombstones: delete ALL pre-existing live tombstone keys we
        // captured at step 2. They are obsolete in both possible cases —
        // either (a) the id appeared in the manifest and we just wrote a
        // fresh `<id>/<now>` key, or (b) the id wasn't in the manifest and
        // shouldn't have a tombstone in restored state at all. Note we use
        // the full key (including the old deletedAt path segment), so the
        // newly-written `<now>` keys are not in this list.
        const allOldTombKeys = [...liveBookTombs, ...liveCollTombs];
        await parallelPool(allOldTombKeys, async (key) => {
            await client.send(new sdk.DeleteObjectCommand({
                Bucket: bucket,
                Key: key
            }));
        });
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const client = this.deps.getClient();
        const sdk = this.deps.getSdk();
        const bucket = this.deps.getBucket();
        const dirPrefix = this.snapshotPrefix(snapshotId);
        const keys: string[] = [];
        let continuationToken: string | undefined;
        do {
            const res = await client.send(new sdk.ListObjectsV2Command({
                Bucket: bucket,
                Prefix: dirPrefix,
                ContinuationToken: continuationToken
            }));
            for (const obj of res.Contents ?? []) {
                if (obj.Key) keys.push(obj.Key);
            }
            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);

        await parallelPool(keys, async (key) => {
            await client.send(new sdk.DeleteObjectCommand({
                Bucket: bucket,
                Key: key
            }));
        });
    }

    /**
     * Like the backend's `listTombstones()` but returns the full S3 keys
     * (one per object, NOT deduped per id). Restore needs every old key so
     * it can wipe them in the diff-delete phase; per-id dedupe would lose
     * tombstones with the same id but different deletedAt.
     */
    private async listTombstoneKeys(resource: SyncResource): Promise<string[]> {
        const client = this.deps.getClient();
        const sdk = this.deps.getSdk();
        const dirPrefix = `${this.deps.getPrefix()}${this.deps.tombstoneDir[resource]}/`;
        const keys: string[] = [];
        let continuationToken: string | undefined;
        do {
            const res = await client.send(new sdk.ListObjectsV2Command({
                Bucket: this.deps.getBucket(),
                Prefix: dirPrefix,
                ContinuationToken: continuationToken
            }));
            for (const obj of res.Contents ?? []) {
                if (obj.Key) keys.push(obj.Key);
            }
            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);
        return keys;
    }
}
