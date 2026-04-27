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
    S3ServiceException,
    type GetBucketCorsCommandOutput
} from '@aws-sdk/client-s3';
import { SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId, S3Config } from './sync.types';

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
const META_DELETED_AT = 'deleted-at';

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

    constructor(config: S3Config) {
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
    private browserOrigin(): string {
        return typeof window !== 'undefined' && window.location?.origin
            ? window.location.origin
            : '*';
    }

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
                AllowedOrigins: [this.browserOrigin()],
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
        try {
            const head = await this.client.send(new HeadObjectCommand({
                Bucket: this.bucket,
                Key: p.key
            }));
            const metaValue = head.Metadata?.[META_LAST_ACTIVE];
            if (metaValue) {
                return {
                    ...fallback,
                    lastActiveAt: Number(metaValue) || p.modifiedAt
                };
            }
            // Metadata missing (CORS strip or never written) — read body.
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

    private tombstoneKey(resource: SyncResource, id: string): string {
        return `${this.prefix}${TOMBSTONE_DIR[resource]}/${id}`;
    }

    /**
     * Lists tombstone objects under the resource's tombstone prefix and
     * recovers `deletedAt` from each one's user metadata. Same CORS/HEAD
     * concurrency strategy as `list()`. If metadata is unavailable (CORS
     * stripping it AND no GET-body fallback because tombstones are empty),
     * we fall back to LastModified.
     */
    async listTombstones(resource: SyncResource): Promise<Tombstone[]> {
        const dirPrefix = `${this.prefix}${TOMBSTONE_DIR[resource]}/`;
        const partial: { id: string; modifiedAt: number; key: string }[] = [];
        let continuationToken: string | undefined;

        do {
            const res = await this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: dirPrefix,
                ContinuationToken: continuationToken
            }));

            for (const obj of res.Contents ?? []) {
                if (!obj.Key) continue;
                const id = obj.Key.slice(dirPrefix.length);
                if (!id) continue;
                partial.push({
                    id,
                    modifiedAt: obj.LastModified ? obj.LastModified.getTime() : 0,
                    key: obj.Key
                });
            }
            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);

        const HYDRATE_CONCURRENCY = 8;
        const result: Tombstone[] = new Array(partial.length);
        let cursor = 0;
        const workers = Array.from(
            { length: Math.min(HYDRATE_CONCURRENCY, partial.length) },
            async () => {
                while (cursor < partial.length) {
                    const i = cursor++;
                    const p = partial[i];
                    let deletedAt = p.modifiedAt;
                    try {
                        const head = await this.client.send(new HeadObjectCommand({
                            Bucket: this.bucket,
                            Key: p.key
                        }));
                        const metaValue = head.Metadata?.[META_DELETED_AT];
                        if (metaValue) deletedAt = Number(metaValue) || p.modifiedAt;
                    } catch {
                        // fall back to modifiedAt
                    }
                    result[i] = { id: p.id, deletedAt };
                }
            }
        );
        await Promise.all(workers);
        return result;
    }

    async writeTombstone(resource: SyncResource, id: string, deletedAt: number): Promise<void> {
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.tombstoneKey(resource, id),
            Body: '',
            ContentType: 'application/octet-stream',
            Metadata: { [META_DELETED_AT]: String(deletedAt) }
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
}
