import { Injectable, inject } from '@angular/core';
import { WINDOW } from '@app/core/tokens/window.token';
import type {
    S3Client,
    GetBucketCorsCommandOutput
} from '@aws-sdk/client-s3';
import {
    SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId, S3Config,
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotLocalPayload
} from '../sync.types';
import { S3ConfigService } from './s3-config.service';
import { S3SnapshotStore } from './s3-snapshot-store';
import { createParallelPool } from '@app/core/utils/async.util';
import { SNAPSHOT_CONCURRENCY } from '../sync-snapshot-utils';

type AwsSdk = typeof import('@aws-sdk/client-s3');

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);

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
// Hyphen rather than underscore — RFC 7230 disallows underscore in HTTP
// header names, and SeaweedFS rejects the SigV4 of `x-amz-meta-last_active`
// outright. AWS S3 itself tolerates underscores; hyphen works on both.
const META_LAST_ACTIVE = 'last-active';

@Injectable({ providedIn: 'root' })
export class S3SyncBackend implements SyncBackend {
    readonly id: SyncBackendId = 's3';
    readonly label = 'S3-compatible';
    readonly supportsBackgroundSync = true;

    private readonly cfg = inject(S3ConfigService);
    private readonly win = inject(WINDOW);

    /**
     * Lazily-imported AWS SDK module. Static imports are deliberately
     * `import type` only so this file can be statically loaded (and DI-
     * registered) without pulling the SDK chunk. `initAsync` does the
     * runtime `import()` on first use.
     */
    private sdk: AwsSdk | null = null;
    private client: S3Client | null = null;
    private bucket = '';
    private prefix = '';
    private corsAttempted = false;
    private corsOk = false;
    private fingerprint = '';
    private initPromise: Promise<void> | null = null;

    isReady(): boolean {
        return this.cfg.isConfigured();
    }

    configFingerprint(): string {
        const c = this.cfg.config();
        return c ? JSON.stringify(c) : '';
    }

    /**
     * Idempotent. First call dynamically imports the AWS SDK and builds
     * an S3Client; subsequent calls no-op unless the config fingerprint
     * changed (then rebuild + reset CORS-attempt cache).
     *
     * Single-flight: concurrent callers share the same in-flight init
     * promise. Without this, the second caller could destroy the client
     * the first caller just constructed (a `this.client?.destroy()` in
     * the body races against the other branch). This is the realistic
     * code path — UI dialogs that spin up multiple resource reads in
     * rapid succession all hit `initAsync` before any of them returns.
     */
    initAsync(): Promise<void> {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this.doInit().finally(() => { this.initPromise = null; });
        return this.initPromise;
    }

    private async doInit(): Promise<void> {
        const c = this.cfg.config();
        if (!c) throw new Error('S3 backend is not configured.');
        const fp = JSON.stringify(c);
        if (this.client && this.fingerprint === fp) return;
        if (!this.sdk) this.sdk = await import('@aws-sdk/client-s3');
        // Tear down the previous client (releases keep-alive HTTP handler
        // + aborts pending requests) before swapping in one bound to new
        // creds; otherwise the old socket pool can leak across config
        // changes.
        this.client?.destroy();
        this.bucket = c.bucket;
        this.prefix = c.prefix ? c.prefix.replace(/^\/+|\/+$/g, '') + '/' : '';
        this.client = new this.sdk.S3Client({
            endpoint: c.endpoint,
            region: c.region || 'us-east-1',
            credentials: {
                accessKeyId: c.accessKeyId,
                secretAccessKey: c.secretAccessKey
            },
            forcePathStyle: c.forcePathStyle ?? true
        });
        this.fingerprint = fp;
        this.corsAttempted = false;
        this.corsOk = false;
    }

    /**
     * Test arbitrary config without binding the singleton. Used by the
     * settings UI's "Test connection" button before saving. Builds a
     * throwaway client with the candidate config; doesn't touch instance
     * state.
     *
     * Also runs the CORS auto-apply step (best-effort) so the user gets
     * the manual-fix hint at Test time, not silently on the first sync.
     */
    async testConfig(config: S3Config): Promise<void> {
        const sdk = this.sdk ?? (this.sdk = await import('@aws-sdk/client-s3'));
        const client = new sdk.S3Client({
            endpoint: config.endpoint,
            region: config.region || 'us-east-1',
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey
            },
            forcePathStyle: config.forcePathStyle ?? true
        });
        try {
            await client.send(new sdk.HeadBucketCommand({ Bucket: config.bucket }));
            const ok = await this.applyCorsToBucket(sdk, client, config.bucket);
            if (!ok) {
                console.warn(
                    '[S3] Bucket reachable, but CORS auto-apply failed. Sync ' +
                    'will use the slower GET-body fallback for last-active ' +
                    'recovery. To enable the fast path, manually add ' +
                    '`x-amz-meta-last-active` to the bucket\'s CORS ExposeHeaders.'
                );
            }
        } finally {
            // Throwaway client owns its own socket pool; release it
            // regardless of whether HeadBucket / CORS apply succeeded.
            client.destroy();
        }
    }

    isAuthenticated(): boolean {
        return true; // Stateless: SigV4 per-request
    }

    async authenticate(): Promise<void> {
        // No-op; AWS SDK signs each request with provided creds.
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
        this.corsOk = await this.applyCorsToBucket(this.sdk!, this.client!, this.bucket);
        return this.corsOk;
    }

    /**
     * Pure form of the CORS auto-apply: takes an explicit (sdk, client,
     * bucket), no instance-cache writes. Used by both `ensureCorsApplied`
     * (instance, with caching) and `testConfig` (throwaway client). Returns
     * true if the bucket is in a usable state at the end (already-correct
     * or successfully written), false if neither GET nor PUT succeeded.
     */
    private async applyCorsToBucket(sdk: AwsSdk, client: S3Client, bucket: string): Promise<boolean> {
        const targetHeader = 'x-amz-meta-' + META_LAST_ACTIVE;
        const targetLower = targetHeader.toLowerCase();

        // Step 1: read current config. Many backends 404 on GET when no CORS
        // is configured — treat that as "needs default rule".
        let existingRules: NonNullable<GetBucketCorsCommandOutput['CORSRules']> = [];
        try {
            const got = await client.send(new sdk.GetBucketCorsCommand({ Bucket: bucket }));
            existingRules = got.CORSRules ?? [];
        } catch (e) {
            if (!(e instanceof sdk.S3ServiceException && (e.name === 'NoSuchCORSConfiguration' || e.$metadata?.httpStatusCode === 404))) {
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
        if (allCovered) return true;

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
                AllowedOrigins: [this.win.location.origin],
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
            await client.send(new sdk.PutBucketCorsCommand({
                Bucket: bucket,
                CORSConfiguration: { CORSRules: mergedRules }
            }));
            return true;
        } catch (e) {
            console.error(
                '[S3] PutBucketCors failed. The browser SDK will not see ' +
                '`x-amz-meta-last-active` on HEAD; sync falls back to ' +
                'GET-body for each entry (correct but slower).',
                e
            );
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
            const res = await this.client!.send(new this.sdk!.ListObjectsV2Command({
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
        const entries: RemoteEntry[] = new Array(partial.length);
        await parallelPool(partial, async (p, i) => {
            entries[i] = await this.hydrateRemoteEntry(p);
        });

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
            const head = await this.client!.send(new this.sdk!.HeadObjectCommand({
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
        // ResponseCacheControl tells the server to set Cache-Control: no-store
        // on its reply, so Chrome's HTTP disk cache doesn't serve stale bodies
        // on subsequent GETs (heuristic freshness off Last-Modified would
        // otherwise mask post-PUT updates inside the cache window).
        try {
            const get = await this.client!.send(new this.sdk!.GetObjectCommand({
                Bucket: this.bucket,
                Key: p.key,
                ResponseCacheControl: 'no-store'
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
        const res = await this.client!.send(new this.sdk!.GetObjectCommand({
            Bucket: this.bucket,
            Key: this.keyFor(resource, id),
            ResponseCacheControl: 'no-store'
        }));
        if (!res.Body) throw new Error(`S3: empty body for ${resource}/${id}`);
        return res.Body.transformToString();
    }

    async write(resource: SyncResource, id: string, json: string, lastActiveAt: number): Promise<void> {
        const key = this.keyFor(resource, id);
        await this.client!.send(new this.sdk!.PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: json,
            ContentType: 'application/json',
            Metadata: { [META_LAST_ACTIVE]: String(lastActiveAt) }
        }));
    }

    async remove(resource: SyncResource, id: string): Promise<void> {
        await this.client!.send(new this.sdk!.DeleteObjectCommand({
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
            const res = await this.client!.send(new this.sdk!.ListObjectsV2Command({
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
        await this.client!.send(new this.sdk!.PutObjectCommand({
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
            const res = await this.client!.send(new this.sdk!.ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: dirPrefix,
                ContinuationToken: continuationToken
            }));
            const keys = (res.Contents ?? []).map(o => o.Key).filter((k): k is string => !!k);
            // Sequential delete: AWS DeleteObjects multi isn't universally
            // supported on S3-compatible servers, and the tombstone count
            // here is small (one per ever-deleted entity).
            for (const key of keys) {
                await this.client!.send(new this.sdk!.DeleteObjectCommand({
                    Bucket: this.bucket,
                    Key: key
                }));
            }
            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);
    }

    async readSettings(): Promise<string | null> {
        try {
            const res = await this.client!.send(new this.sdk!.GetObjectCommand({
                Bucket: this.bucket,
                Key: this.settingsKey(),
                ResponseCacheControl: 'no-store'
            }));
            if (!res.Body) return null;
            return await res.Body.transformToString();
        } catch (e) {
            if (this.isNotFound(e)) return null;
            throw e;
        }
    }

    async writeSettings(content: string): Promise<void> {
        await this.client!.send(new this.sdk!.PutObjectCommand({
            Bucket: this.bucket,
            Key: this.settingsKey(),
            Body: content,
            ContentType: 'application/json'
        }));
    }

    async readPrompts(): Promise<string | null> {
        try {
            const res = await this.client!.send(new this.sdk!.GetObjectCommand({
                Bucket: this.bucket,
                Key: this.promptsKey(),
                ResponseCacheControl: 'no-store'
            }));
            if (!res.Body) return null;
            return await res.Body.transformToString();
        } catch (e) {
            if (this.isNotFound(e)) return null;
            throw e;
        }
    }

    async writePrompts(content: string): Promise<void> {
        await this.client!.send(new this.sdk!.PutObjectCommand({
            Bucket: this.bucket,
            Key: this.promptsKey(),
            Body: content,
            ContentType: 'application/json'
        }));
    }

    private isNotFound(err: unknown): boolean {
        if (this.sdk && err instanceof this.sdk.S3ServiceException) {
            return err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
        }
        return false;
    }

    // ===== Snapshots — delegated to S3SnapshotStore ======================

    private readonly snapshotStore = new S3SnapshotStore({
        getClient: () => this.client!,
        getSdk: () => this.sdk!,
        getBucket: () => this.bucket,
        getPrefix: () => this.prefix,
        resourceDir: RESOURCE_DIR,
        tombstoneDir: TOMBSTONE_DIR,
        keyFor: (r, id) => this.keyFor(r, id),
        tombstoneKey: (r, id, deletedAt) => this.tombstoneKey(r, id, deletedAt),
        isNotFound: (err) => this.isNotFound(err),
        ops: {
            list: (r) => this.list(r),
            listTombstones: (r) => this.listTombstones(r),
            write: (r, id, json, ts) => this.write(r, id, json, ts),
            writeTombstone: (r, id, ts) => this.writeTombstone(r, id, ts),
            remove: (r, id) => this.remove(r, id)
        }
    });

    listSnapshots(): Promise<SnapshotMeta[]> { return this.snapshotStore.listSnapshots(); }
    readSnapshotManifest(id: string): Promise<SnapshotManifest> { return this.snapshotStore.readSnapshotManifest(id); }
    createSnapshotFromCloud(id: string, meta: SnapshotMetaInput): Promise<SnapshotManifest> {
        return this.snapshotStore.createSnapshotFromCloud(id, meta);
    }
    createSnapshotFromLocal(id: string, meta: SnapshotMetaInput, payload: SnapshotLocalPayload): Promise<SnapshotManifest> {
        return this.snapshotStore.createSnapshotFromLocal(id, meta, payload);
    }
    restoreSnapshot(id: string): Promise<void> { return this.snapshotStore.restoreSnapshot(id); }
    deleteSnapshot(id: string): Promise<void> { return this.snapshotStore.deleteSnapshot(id); }
    updateSnapshotNote(id: string, note: string): Promise<void> {
        return this.snapshotStore.updateSnapshotNote(id, note);
    }
}
