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
    S3ServiceException
} from '@aws-sdk/client-s3';
import { SyncBackend, SyncResource, RemoteEntry, SyncBackendId, S3Config } from './sync.types';

const RESOURCE_DIR: Record<SyncResource, string> = {
    book: 'books',
    collection: 'collections'
};
const SETTINGS_KEY = 'settings.json';
const PROMPTS_KEY = 'prompts.json';
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
     * Reachability check used by the settings UI's Test button. Also runs
     * `ensureCorsApplied` so that an explicit user-initiated Test surfaces
     * any CORS configuration problem (we throw with a descriptive message
     * if PUT fails — the calling component shows it as a snackbar).
     */
    async testConnection(): Promise<void> {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
        const ok = await this.ensureCorsApplied();
        if (!ok) {
            throw new Error(
                'Bucket reachable, but the CORS rule needed to expose ' +
                '`x-amz-meta-last-active` to the browser is missing AND we ' +
                "couldn't update it (likely insufficient permission or server " +
                "doesn't accept PutBucketCors). Sync will still work via a " +
                'slower full-body fetch path. To fix, manually add ' +
                '`x-amz-meta-last-active` to the bucket\'s CORS ExposeHeaders.'
            );
        }
    }

    /**
     * Idempotent best-effort: GET current bucket CORS, return true if it
     * already exposes `x-amz-meta-last-active`. Otherwise PUT a rule that
     * does. Cached per backend-instance lifetime — once we've decided yes
     * or no, we don't retry until the backend is rebuilt (config change).
     *
     * Returns true if the bucket is in a usable state at the end of this
     * call (already-correct, or we successfully wrote it). Returns false
     * if the bucket is unconfigured AND we couldn't write — in that case
     * the GET-body fallback in `list()` keeps sync correct, just slower.
     */
    private async ensureCorsApplied(): Promise<boolean> {
        if (this.corsAttempted) return this.corsOk;
        this.corsAttempted = true;

        // Step 1: read current config and check whether our needed expose
        // header is already there. Many backends 404 on GET when no CORS
        // is configured — treat that as "needs PUT".
        try {
            const got = await this.client.send(new GetBucketCorsCommand({
                Bucket: this.bucket
            }));
            const targetHeader = ('x-amz-meta-' + META_LAST_ACTIVE).toLowerCase();
            const exposed = (got.CORSRules ?? []).some(r =>
                (r.ExposeHeaders ?? []).some(h => h.toLowerCase() === targetHeader)
            );
            if (exposed) {
                this.corsOk = true;
                return true;
            }
        } catch (e) {
            if (!this.isNotFound(e)) {
                // Surfaceable error other than NoSuchCORSConfiguration.
                console.warn('[S3] GetBucketCors unexpected error; will try PUT anyway.', e);
            }
        }

        // Step 2: PUT a comprehensive rule. SeaweedFS persists this in bucket
        // metadata; AWS S3 likewise. Failure (often 403) means the user's key
        // can't write bucket-level config — we surface that via testConnection.
        try {
            await this.client.send(new PutBucketCorsCommand({
                Bucket: this.bucket,
                CORSConfiguration: {
                    CORSRules: [{
                        AllowedOrigins: ['*'],
                        AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD', 'DELETE'],
                        AllowedHeaders: ['*'],
                        ExposeHeaders: [
                            'ETag',
                            'Content-Length',
                            'Content-Type',
                            'Last-Modified',
                            'x-amz-meta-' + META_LAST_ACTIVE,
                            'x-amz-request-id'
                        ],
                        MaxAgeSeconds: 3600
                    }]
                }
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

        // Parallel HEAD to pull `last-active` user metadata for each entry.
        //
        // Browser CORS gotcha: `x-amz-meta-*` response headers are stripped
        // by the browser unless the server explicitly lists them in
        // `Access-Control-Expose-Headers`. Node SDK sees them; browser SDK
        // doesn't. When metadata comes back empty we fall back to GET body
        // and parse `lastActiveAt` directly out of the JSON. That's an
        // extra full-body fetch per object on every sync until the user
        // fixes their server CORS config, but it produces correct sync
        // decisions either way.
        const entries = await Promise.all(partial.map(async p => {
            try {
                const head = await this.client.send(new HeadObjectCommand({
                    Bucket: this.bucket,
                    Key: p.key
                }));
                const metaValue = head.Metadata?.[META_LAST_ACTIVE];
                if (metaValue) {
                    return {
                        id: p.id,
                        lastActiveAt: Number(metaValue) || p.modifiedAt,
                        modifiedAt: p.modifiedAt,
                        etag: p.etag,
                        size: p.size
                    } as RemoteEntry;
                }
                // Metadata missing (CORS strip or never written) — read body.
                const get = await this.client.send(new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: p.key
                }));
                const text = await get.Body!.transformToString();
                const body = JSON.parse(text) as { lastActiveAt?: number; updatedAt?: number };
                const bodyTime = Number(body.lastActiveAt ?? body.updatedAt) || p.modifiedAt;
                return {
                    id: p.id,
                    lastActiveAt: bodyTime,
                    modifiedAt: p.modifiedAt,
                    etag: p.etag,
                    size: p.size
                } as RemoteEntry;
            } catch {
                return {
                    id: p.id,
                    lastActiveAt: p.modifiedAt,
                    modifiedAt: p.modifiedAt,
                    etag: p.etag,
                    size: p.size
                } as RemoteEntry;
            }
        }));

        return entries;
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
