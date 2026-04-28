import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    HeadObjectCommand,
    HeadBucketCommand,
    GetBucketCorsCommand,
    PutBucketCorsCommand,
    CopyObjectCommand,
    S3ServiceException,
    type GetBucketCorsCommandOutput
} from '@aws-sdk/client-s3';
import {
    SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId, S3Config,
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotEntryRef,
    SnapshotTombstoneRef, SnapshotSkipped, SnapshotLocalPayload, assertSnapshotId
} from './sync.types';

const RESOURCE_DIR: Record<SyncResource, string> = {
    book: 'books',
    collection: 'collections'
};
const TOMBSTONE_DIR: Record<SyncResource, string> = {
    book: 'tombstones/books',
    collection: 'tombstones/collections'
};
const SETTINGS_KEY = 'settings.json';
const PROMPTS_KEY = 'prompts.json';
const SNAPSHOTS_DIR = 'snapshots';
const SNAPSHOT_MANIFEST_NAME = 'manifest.json';
const SNAPSHOT_CONCURRENCY = 8;
// Hyphen rather than underscore — RFC 7230 disallows underscore in HTTP
// header names, and SeaweedFS rejects the SigV4 of `x-amz-meta-last_active`
// outright. AWS S3 itself tolerates underscores; hyphen works on both.
const META_LAST_ACTIVE = 'last-active';

export class S3SyncBackend implements SyncBackend {
    readonly id: SyncBackendId = 's3';
    readonly label = 'S3-compatible';
    readonly isConfigured = true;
    readonly supportsBackgroundSync = true;

    private client: S3Client;
    private bucket: string;
    private prefix: string;
    private corsAttempted = false;
    private corsOk = false;
    private readonly origin: string;

    constructor(config: S3Config, origin = '*') {
        this.origin = origin;
        this.bucket = config.bucket;
        this.prefix = config.prefix ? config.prefix.replace(/^\/+|\/+$/g, '') + '/' : '';
        this.client = new S3Client({
            endpoint: config.endpoint,
            region: config.region || 'us-east-1',
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey
            },
            forcePathStyle: config.forcePathStyle ?? true
        });
    }

    isAuthenticated(): boolean {
        return true; // Stateless: SigV4 per-request
    }

    async authenticate(): Promise<void> {
        // No-op; AWS SDK signs each request with provided creds.
    }

    /**
     * Reachability check used by the settings UI's Test button. The actual
     * gating signal is whether `HeadBucket` succeeds — that proves SigV4
     * creds + bucket existence + network path. CORS auto-apply is a
     * best-effort optimisation; if it fails (no `s3:PutBucketCors`
     * permission, server rejects, etc.) sync still works via the slower
     * GET-body fallback in `list()`, so we don't fail the test on it —
     * just log so the user can investigate if curious.
     */
    async testConnection(): Promise<void> {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        const ok = await this.ensureCorsApplied();
        if (!ok) {
            console.warn(
                '[S3] Bucket reachable, but CORS auto-apply failed. Sync ' +
                'will use the slower GET-body fallback for last-active ' +
                'recovery. To enable the fast path, manually add ' +
                '`x-amz-meta-last-active` to the bucket\'s CORS ExposeHeaders.'
            );
        }
    }

    /**
     * Idempotent best-effort: GET current bucket CORS, augment in place to
     * expose `x-amz-meta-last-active` on every existing rule (or write a
     * permissive default if none exist). Cached per backend-instance
     * lifetime — once we've decided yes or no, we don't retry until the
     * backend is rebuilt (config change).
     *
     * Non-destructive: existing rules' AllowedOrigins/Methods/Headers are
     * preserved; we only ADD our header to each rule's ExposeHeaders if
     * missing. Bucket may be shared with other apps — clobbering their
     * rules would break their integrations. Appending a new rule wouldn't
     * help either, since S3 CORS uses first-match: an existing rule that
     * matches the browser request but lacks our header would still win
     * and the header would stay stripped.
     *
     * Returns true if the bucket is in a usable state at the end of this
     * call (already-correct, or we successfully wrote it). Returns false
     * if we couldn't read AND couldn't write — in that case the GET-body
     * fallback in `list()` keeps sync correct, just slower.
     */
    private async ensureCorsApplied(): Promise<boolean> {
        if (this.corsAttempted) return this.corsOk;
        this.corsAttempted = true;

        const targetHeader = 'x-amz-meta-' + META_LAST_ACTIVE;
        const targetLower = targetHeader.toLowerCase();

        // Step 1: read current config. Many backends 404 on GET when no CORS
        // is configured — treat that as "needs default rule".
        let existingRules: NonNullable<GetBucketCorsCommandOutput['CORSRules']> = [];
        try {
            const got = await this.client.send(new GetBucketCorsCommand({
                Bucket: this.bucket
            }));
            existingRules = got.CORSRules ?? [];
        } catch (e) {
            if (!this.isNotFound(e)) {
                // Surfaceable error other than NoSuchCORSConfiguration.
                console.warn('[S3] GetBucketCors unexpected error; will try PUT anyway.', e);
            }
        }

        // If every existing rule already exposes our header, nothing to do.
        // Note this is conservative — even one rule missing it triggers a
        // merge, since CORS picks first-match and we can't know which rule
        // any given browser request will land on.
        const allCovered = existingRules.length > 0 && existingRules.every(r =>
            (r.ExposeHeaders ?? []).some(h => h.toLowerCase() === targetLower)
        );
        if (allCovered) {
            this.corsOk = true;
            return true;
        }

        // Step 2: build merged rules. Existing rules: append our header to
        // ExposeHeaders if missing, preserve everything else. No existing
        // rules: write a permissive default.
        const mergedRules = existingRules.length > 0
            ? existingRules.map(r => ({
                ...r,
                ExposeHeaders: (r.ExposeHeaders ?? []).some(h => h.toLowerCase() === targetLower)
                    ? r.ExposeHeaders
                    : [...(r.ExposeHeaders ?? []), targetHeader]
            }))
            : [{
                // Narrow to this app's origin — broad `*` would expose the
                // bucket's CORS surface to any site the user visits. The
                // actual security barrier is still SigV4 signing, but
                // there's no reason to be looser than necessary.
                AllowedOrigins: [this.origin],
                AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD', 'DELETE'],
                AllowedHeaders: ['*'],
                ExposeHeaders: [
                    'ETag',
                    'Content-Length',
                    'Content-Type',
                    'Last-Modified',
                    targetHeader,
                    'x-amz-request-id'
                ],
                MaxAgeSeconds: 3600
            }];

        try {
            await this.client.send(new PutBucketCorsCommand({
                Bucket: this.bucket,
                CORSConfiguration: { CORSRules: mergedRules }
            }));
            this.corsOk = true;
            return true;
        } catch (e) {
            console.error(
                '[S3] PutBucketCors failed. The browser SDK will not see ' +
                '`x-amz-meta-last-active` on HEAD; sync falls back to ' +
                'GET-body for each entry (correct but slower).',
                e
            );
            this.corsOk = false;
            return false;
        }
    }

    private keyFor(resource: SyncResource, id: string): string {
        return `${this.prefix}${RESOURCE_DIR[resource]}/${id}.json`;
    }

    private settingsKey(): string {
        return `${this.prefix}${SETTINGS_KEY}`;
    }

    private promptsKey(): string {
        return `${this.prefix}${PROMPTS_KEY}`;
    }

    /**
     * Lists objects under the resource prefix, then fans out parallel
     * HeadObject requests to recover each object's `last_active` user
     * metadata. Recovery cost is one extra round-trip per file but the
     * returned `lastActiveAt` is in device-clock domain and lets the sync
     * decision logic stay clock-skew-free.
     */
    async list(resource: SyncResource): Promise<RemoteEntry[]> {
        // First sync per backend instance also applies bucket CORS so the
        // browser SDK can read `x-amz-meta-last-active` on subsequent HEADs.
        await this.ensureCorsApplied();
        const dirPrefix = `${this.prefix}${RESOURCE_DIR[resource]}/`;
        const partial: { id: string; modifiedAt: number; etag?: string; size?: number; key: string }[] = [];
        let continuationToken: string | undefined;

        do {
            const res = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: dirPrefix,
                ContinuationToken: continuationToken
            }));

            for (const obj of res.Contents ?? []) {
                if (!obj.Key || !obj.Key.endsWith('.json')) continue;
                const id = obj.Key.slice(dirPrefix.length, -5);
                if (!id) continue;
                partial.push({
                    id,
                    modifiedAt: obj.LastModified ? obj.LastModified.getTime() : 0,
                    etag: obj.ETag,
                    size: obj.Size,
                    key: obj.Key
                });
            }

            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);

        // HEAD per entry to pull `last-active` user metadata.
        //
        // Browser CORS gotcha: `x-amz-meta-*` response headers are stripped
        // by the browser unless the server explicitly lists them in
        // `Access-Control-Expose-Headers`. Node SDK sees them; browser SDK
        // doesn't. When metadata comes back empty we fall back to GET body
        // and parse `lastActiveAt` directly out of the JSON. That's an
        // extra full-body fetch per object on every sync until the user
        // fixes their server CORS config, but it produces correct sync
        // decisions either way.
        //
        // Concurrency capped: a List page can return up to 1000 keys, and
        // firing that many HEADs at once exhausts browser connection pools
        // and trips 429s on smaller S3 backends.
        const HYDRATE_CONCURRENCY = 8;
        const entries: RemoteEntry[] = new Array(partial.length);
        let cursor = 0;
        const workers = Array.from(
            { length: Math.min(HYDRATE_CONCURRENCY, partial.length) },
            async () => {
                while (cursor < partial.length) {
                    const i = cursor++;
                    entries[i] = await this.hydrateRemoteEntry(partial[i]);
                }
            }
        );
        await Promise.all(workers);

        return entries;
    }

    private async hydrateRemoteEntry(p: {
        id: string; modifiedAt: number; etag?: string; size?: number; key: string;
    }): Promise<RemoteEntry> {
        const fallback: RemoteEntry = {
            id: p.id,
            lastActiveAt: p.modifiedAt,
            modifiedAt: p.modifiedAt,
            etag: p.etag,
            size: p.size
        };

        // HEAD in its own try so a HEAD failure (permission delta, network
        // blip, CORS edge case) doesn't skip the GET-body fallback below.
        let metaValue: string | undefined;
        try {
            const head = await this.client.send(new HeadObjectCommand({
                Bucket: this.bucket,
                Key: p.key
            }));
            metaValue = head.Metadata?.[META_LAST_ACTIVE];
        } catch {
            // Fall through to GET-body — that path also recovers lastActiveAt.
        }
        if (metaValue) {
            return { ...fallback, lastActiveAt: Number(metaValue) || p.modifiedAt };
        }

        // Metadata missing (CORS strip or never written) — read body.
        try {
            const get = await this.client.send(new GetObjectCommand({
                Bucket: this.bucket,
                Key: p.key
            }));
            if (!get.Body) return fallback;
            const text = await get.Body.transformToString();
            const body = JSON.parse(text) as { lastActiveAt?: number; updatedAt?: number };
            const bodyTime = Number(body.lastActiveAt ?? body.updatedAt) || p.modifiedAt;
            return { ...fallback, lastActiveAt: bodyTime };
        } catch {
            return fallback;
        }
    }

    async read(resource: SyncResource, id: string): Promise<string> {
        const res = await this.client.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: this.keyFor(resource, id)
        }));
        if (!res.Body) throw new Error(`S3: empty body for ${resource}/${id}`);
        return res.Body.transformToString();
    }

    async write(resource: SyncResource, id: string, json: string, lastActiveAt: number): Promise<void> {
        const key = this.keyFor(resource, id);
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: json,
            ContentType: 'application/json',
            Metadata: { [META_LAST_ACTIVE]: String(lastActiveAt) }
        }));
    }

    async remove(resource: SyncResource, id: string): Promise<void> {
        await this.client.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: this.keyFor(resource, id)
        }));
    }

    private tombstoneKey(resource: SyncResource, id: string, deletedAt: number): string {
        return `${this.prefix}${TOMBSTONE_DIR[resource]}/${id}/${deletedAt}`;
    }

    /**
     * Lists tombstones via a single ListObjectsV2 page-walk — no per-object
     * HEAD. The `deletedAt` timestamp is encoded directly into the key
     * (`tombstones/<resource>/<id>/<deletedAt>`), so ListObjectsV2 returns
     * everything we need.
     *
     * If the same id was deleted multiple times (delete → restore →
     * re-delete on different devices), there will be multiple keys for it
     * — we keep the maximum `deletedAt` per id, which is the only one that
     * matters for the newer-wins comparison.
     *
     * Tombstones are never auto-removed (cheap, ~50 bytes each) so a long-
     * offline device still receives the message when it comes back.
     */
    async listTombstones(resource: SyncResource): Promise<Tombstone[]> {
        const dirPrefix = `${this.prefix}${TOMBSTONE_DIR[resource]}/`;
        const latest = new Map<string, number>();
        let continuationToken: string | undefined;

        do {
            const res = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: dirPrefix,
                ContinuationToken: continuationToken
            }));

            for (const obj of res.Contents ?? []) {
                if (!obj.Key) continue;
                // Key shape: <prefix>tombstones/<resource>/<id>/<deletedAt>
                // Assumes ids are slash-free, which holds for all current
                // id sources (UUIDs / nanoid / Date.now-based). If a future
                // id scheme introduces slashes, switch the separator (e.g.
                // null byte or unicode delimiter) here AND in tombstoneKey.
                const rel = obj.Key.slice(dirPrefix.length);
                const slashIdx = rel.lastIndexOf('/');
                if (slashIdx <= 0) continue; // malformed; skip
                const id = rel.slice(0, slashIdx);
                const deletedAt = Number(rel.slice(slashIdx + 1));
                if (!id || !Number.isFinite(deletedAt)) continue;
                const prev = latest.get(id);
                if (prev === undefined || deletedAt > prev) latest.set(id, deletedAt);
            }
            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);

        return Array.from(latest, ([id, deletedAt]) => ({ id, deletedAt }));
    }

    async writeTombstone(resource: SyncResource, id: string, deletedAt: number): Promise<void> {
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.tombstoneKey(resource, id, deletedAt),
            Body: '',
            ContentType: 'application/octet-stream'
        }));
    }

    async clearTombstones(resource: SyncResource): Promise<void> {
        const dirPrefix = `${this.prefix}${TOMBSTONE_DIR[resource]}/`;
        let continuationToken: string | undefined;
        do {
            const res = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: dirPrefix,
                ContinuationToken: continuationToken
            }));
            const keys = (res.Contents ?? []).map(o => o.Key).filter((k): k is string => !!k);
            // Sequential delete: AWS DeleteObjects multi isn't universally
            // supported on S3-compatible servers, and the tombstone count
            // here is small (one per ever-deleted entity).
            for (const key of keys) {
                await this.client.send(new DeleteObjectCommand({
                    Bucket: this.bucket,
                    Key: key
                }));
            }
            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);
    }

    async readSettings(): Promise<string | null> {
        try {
            const res = await this.client.send(new GetObjectCommand({
                Bucket: this.bucket,
                Key: this.settingsKey()
            }));
            if (!res.Body) return null;
            return await res.Body.transformToString();
        } catch (e) {
            if (this.isNotFound(e)) return null;
            throw e;
        }
    }

    async writeSettings(content: string): Promise<void> {
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.settingsKey(),
            Body: content,
            ContentType: 'application/json'
        }));
    }

    async readPrompts(): Promise<string | null> {
        try {
            const res = await this.client.send(new GetObjectCommand({
                Bucket: this.bucket,
                Key: this.promptsKey()
            }));
            if (!res.Body) return null;
            return await res.Body.transformToString();
        } catch (e) {
            if (this.isNotFound(e)) return null;
            throw e;
        }
    }

    async writePrompts(content: string): Promise<void> {
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.promptsKey(),
            Body: content,
            ContentType: 'application/json'
        }));
    }

    private isNotFound(err: unknown): boolean {
        if (err instanceof S3ServiceException) {
            return err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
        }
        return false;
    }

    // ===== Snapshots =====================================================
    //
    // Layout (mirrors the live tree, scoped to a snapshot id):
    //   <prefix>snapshots/<snapshotId>/manifest.json
    //   <prefix>snapshots/<snapshotId>/books/<id>.json
    //   <prefix>snapshots/<snapshotId>/collections/<id>.json
    //   <prefix>snapshots/<snapshotId>/tombstones/books/<id>/<deletedAt>
    //   <prefix>snapshots/<snapshotId>/tombstones/collections/<id>/<deletedAt>
    //
    // Snapshot objects retain the original `last-active` user metadata
    // (CopyObject MetadataDirective: 'COPY'), so the snapshot is a true
    // historical artefact. Restore reads the snapshot body, re-stamps
    // `lastActiveAt` to Date.now() in BOTH body and metadata, and writes
    // back to live — that's what defeats newer-wins on other devices and
    // self-heal trying to revert the body.

    private snapshotPrefix(snapshotId: string): string {
        return `${this.prefix}${SNAPSHOTS_DIR}/${snapshotId}/`;
    }

    private snapshotManifestKey(snapshotId: string): string {
        return `${this.snapshotPrefix(snapshotId)}${SNAPSHOT_MANIFEST_NAME}`;
    }

    private snapshotBookKey(snapshotId: string, id: string): string {
        return `${this.snapshotPrefix(snapshotId)}${RESOURCE_DIR.book}/${id}.json`;
    }

    private snapshotCollectionKey(snapshotId: string, id: string): string {
        return `${this.snapshotPrefix(snapshotId)}${RESOURCE_DIR.collection}/${id}.json`;
    }

    private snapshotTombstoneKey(
        snapshotId: string, resource: SyncResource, id: string, deletedAt: number
    ): string {
        return `${this.snapshotPrefix(snapshotId)}${TOMBSTONE_DIR[resource]}/${id}/${deletedAt}`;
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
        return `${this.bucket}/${encodedKey}`;
    }

    /**
     * Cursor-based parallel pool, matching the pattern already used in
     * `list()`. Each worker pulls the next index until exhausted; bounded
     * concurrency avoids exhausting browser connection pools and tripping
     * rate limits on smaller S3-compatible servers.
     */
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
        const dirPrefix = `${this.prefix}${SNAPSHOTS_DIR}/`;
        const snapshotIds: string[] = [];
        let continuationToken: string | undefined;
        do {
            const res = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
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
        await this.parallelPool(snapshotIds, async (id, i) => {
            try {
                const manifest = await this.readSnapshotManifest(id);
                // Strip `entries` to keep the list-level payload light.
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { entries, ...meta } = manifest;
                metas[i] = meta;
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
        const res = await this.client.send(new GetObjectCommand({
            Bucket: this.bucket,
            Key: this.snapshotManifestKey(snapshotId)
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

        // 1. Snapshot the live state (parallel; each call is independently paginated).
        const [books, collections, bookTombs, collTombs] = await Promise.all([
            this.list('book'),
            this.list('collection'),
            this.listTombstones('book'),
            this.listTombstones('collection')
        ]);

        // 2. Book-wins dedupe: if an id is both a live entry and a tombstone,
        //    drop the tombstone from the manifest (and skip its copy below).
        const bookIds = new Set(books.map(b => b.id));
        const collIds = new Set(collections.map(c => c.id));
        const filteredBookTombs = bookTombs.filter(t => !bookIds.has(t.id));
        const filteredCollTombs = collTombs.filter(t => !collIds.has(t.id));

        const skipped: SnapshotSkipped[] = [];

        // 3. Copy books / collections (server-side; preserves last-active metadata).
        const bookEntries: SnapshotEntryRef[] = [];
        await this.parallelPool(books, async (b) => {
            const src = this.keyFor('book', b.id);
            const dst = this.snapshotBookKey(snapshotId, b.id);
            try {
                await this.client.send(new CopyObjectCommand({
                    Bucket: this.bucket,
                    CopySource: this.encodeCopySource(src),
                    Key: dst,
                    MetadataDirective: 'COPY'
                }));
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
            const src = this.keyFor('collection', c.id);
            const dst = this.snapshotCollectionKey(snapshotId, c.id);
            try {
                await this.client.send(new CopyObjectCommand({
                    Bucket: this.bucket,
                    CopySource: this.encodeCopySource(src),
                    Key: dst,
                    MetadataDirective: 'COPY'
                }));
                collectionEntries.push({ id: c.id, lastActiveAt: c.lastActiveAt, etag: c.etag, size: c.size });
            } catch (e) {
                if (this.isNotFound(e)) {
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
        await this.parallelPool(allTombs, async ({ resource, t }) => {
            const src = this.tombstoneKey(resource, t.id, t.deletedAt);
            const dst = this.snapshotTombstoneKey(snapshotId, resource, t.id, t.deletedAt);
            try {
                await this.client.send(new CopyObjectCommand({
                    Bucket: this.bucket,
                    CopySource: this.encodeCopySource(src),
                    Key: dst,
                    MetadataDirective: 'COPY'
                }));
                tombstoneEntries.push({ resource, id: t.id, deletedAt: t.deletedAt });
            } catch (e) {
                if (this.isNotFound(e)) {
                    skipped.push({ resource, id: t.id, reason: 'tombstone source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        // 5. Build manifest from the actual copied entries (counts and
        //    sizeBytes are derived here; SnapshotMetaInput's `Pick` excludes
        //    them at the type level so the caller can't supply them).
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

        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
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

        // Book-wins dedupe: caller may pass a tombstone for an id that's
        // also a live entry (e.g. concurrent re-add). Drop the tombstone
        // so restore behaviour matches the from-cloud path.
        const bookIds = new Set(payload.books.map(b => b.id));
        const collIds = new Set(payload.collections.map(c => c.id));
        const filteredTombs = payload.tombstones.filter(t => {
            if (t.resource === 'book') return !bookIds.has(t.id);
            return !collIds.has(t.id);
        });

        const skipped: SnapshotSkipped[] = [];

        const bookEntries: SnapshotEntryRef[] = [];
        await this.parallelPool(payload.books, async (b) => {
            const dst = this.snapshotBookKey(snapshotId, b.id);
            try {
                await this.client.send(new PutObjectCommand({
                    Bucket: this.bucket,
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
        await this.parallelPool(payload.collections, async (c) => {
            const dst = this.snapshotCollectionKey(snapshotId, c.id);
            try {
                await this.client.send(new PutObjectCommand({
                    Bucket: this.bucket,
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
        await this.parallelPool(filteredTombs, async (t) => {
            const dst = this.snapshotTombstoneKey(snapshotId, t.resource, t.id, t.deletedAt);
            try {
                await this.client.send(new PutObjectCommand({
                    Bucket: this.bucket,
                    Key: dst,
                    Body: '',
                    ContentType: 'application/octet-stream'
                }));
                tombstoneEntries.push({ resource: t.resource, id: t.id, deletedAt: t.deletedAt });
            } catch (e) {
                throw new Error(`S3: failed to upload local snapshot tombstone ${t.resource}/${t.id}: ${(e as Error).message}`);
            }
        });

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

        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.snapshotManifestKey(snapshotId),
            Body: JSON.stringify(manifest),
            ContentType: 'application/json'
        }));

        return manifest;
    }

    async updateSnapshotNote(snapshotId: string, note: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const manifest = await this.readSnapshotManifest(snapshotId);
        manifest.note = note;
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.snapshotManifestKey(snapshotId),
            Body: JSON.stringify(manifest),
            ContentType: 'application/json'
        }));
    }

    async restoreSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);

        // 1. Read manifest first. If this fails, abort without touching live.
        const manifest = await this.readSnapshotManifest(snapshotId);

        // 2. Snapshot live state (for diff-delete). Take this BEFORE any
        //    writes so the diff can't accidentally include things we just
        //    wrote ourselves.
        const [liveBooks, liveCollections, liveBookTombs, liveCollTombs] = await Promise.all([
            this.list('book'),
            this.list('collection'),
            this.listTombstoneKeys('book'),
            this.listTombstoneKeys('collection')
        ]);

        const now = Date.now();

        // 3. Write entries from manifest. GET snapshot body, re-stamp body's
        //    lastActiveAt to now, PUT to live with metadata last-active=now.
        //    Both body and metadata get the new timestamp — body alone would
        //    let self-heal revert via metadata, metadata alone would let
        //    other devices see a stale body and propagate it.
        const bookRestoreSrc = manifest.entries.book.map(e => ({
            id: e.id,
            srcKey: this.snapshotBookKey(snapshotId, e.id),
            dstResource: 'book' as const
        }));
        const collRestoreSrc = manifest.entries.collection.map(e => ({
            id: e.id,
            srcKey: this.snapshotCollectionKey(snapshotId, e.id),
            dstResource: 'collection' as const
        }));
        await this.parallelPool([...bookRestoreSrc, ...collRestoreSrc], async (item) => {
            const get = await this.client.send(new GetObjectCommand({
                Bucket: this.bucket,
                Key: item.srcKey
            }));
            if (!get.Body) {
                throw new Error(`S3: empty body for snapshot entry ${item.dstResource}/${item.id}`);
            }
            const text = await get.Body.transformToString();
            const restamped = restampBodyLastActive(text, now);
            await this.write(item.dstResource, item.id, restamped, now);
        });

        // 4. Write tombstones from manifest at NEW deletedAt. The new
        //    deletedAt path is `<prefix>tombstones/<resource>/<id>/<now>`,
        //    distinct from any older `<id>/<oldDeletedAt>` keys — those
        //    older keys are wiped in the diff-delete phase.
        await this.parallelPool(manifest.entries.tombstone, async (t) => {
            await this.writeTombstone(t.resource, t.id, now);
        });

        // 5. Diff-delete. live = manifest after this step.
        const manifestBookIds = new Set(manifest.entries.book.map(e => e.id));
        const manifestCollIds = new Set(manifest.entries.collection.map(e => e.id));

        const booksToDelete = liveBooks.filter(b => !manifestBookIds.has(b.id));
        const collsToDelete = liveCollections.filter(c => !manifestCollIds.has(c.id));

        await this.parallelPool(booksToDelete, async (b) => this.remove('book', b.id));
        await this.parallelPool(collsToDelete, async (c) => this.remove('collection', c.id));

        // For tombstones: delete ALL pre-existing live tombstone keys we
        // captured at step 2. They are obsolete in both possible cases —
        // either (a) the id appeared in the manifest and we just wrote a
        // fresh `<id>/<now>` key, or (b) the id wasn't in the manifest and
        // shouldn't have a tombstone in restored state at all. Note we use
        // the full key (including the old deletedAt path segment), so the
        // newly-written `<now>` keys are not in this list.
        const allOldTombKeys = [...liveBookTombs, ...liveCollTombs];
        await this.parallelPool(allOldTombKeys, async (key) => {
            await this.client.send(new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: key
            }));
        });
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const dirPrefix = this.snapshotPrefix(snapshotId);
        const keys: string[] = [];
        let continuationToken: string | undefined;
        do {
            const res = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: dirPrefix,
                ContinuationToken: continuationToken
            }));
            for (const obj of res.Contents ?? []) {
                if (obj.Key) keys.push(obj.Key);
            }
            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);

        await this.parallelPool(keys, async (key) => {
            await this.client.send(new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: key
            }));
        });
    }

    /**
     * Like `listTombstones()` but returns the full S3 keys (one per object,
     * NOT deduped per id). Restore needs every old key so it can wipe them
     * in the diff-delete phase; the per-id dedupe that listTombstones() does
     * would lose tombstones with the same id but different deletedAt.
     */
    private async listTombstoneKeys(resource: SyncResource): Promise<string[]> {
        const dirPrefix = `${this.prefix}${TOMBSTONE_DIR[resource]}/`;
        const keys: string[] = [];
        let continuationToken: string | undefined;
        do {
            const res = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
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

function byteLength(s: string): number {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    // SSR / non-DOM fallback: char count is close enough for sizeBytes display.
    return s.length;
}

function sumSizes(entries: SnapshotEntryRef[]): number {
    let total = 0;
    for (const e of entries) {
        if (e.size !== undefined) total += e.size;
    }
    return total;
}

/**
 * Replaces the body's `lastActiveAt` field with the restore timestamp.
 *
 * If the JSON parse fails (corrupt snapshot body) or the field isn't there
 * (unlikely — write() always stamps it), the body is returned unchanged so
 * restore at least preserves the snapshot's data. Sync-decision logic still
 * has the metadata `last-active=now` to work from, so newer-wins remains
 * correct even on a body without the field.
 */
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
