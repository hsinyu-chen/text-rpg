import { Injectable, inject } from '@angular/core';
import type {
    S3Client,
    GetBucketCorsCommandOutput
} from '@aws-sdk/client-s3';
import { WINDOW } from '@app/core/tokens/window.token';
import { S3Config } from '../sync.types';
import { META_LAST_ACTIVE } from '../layout/sync-paths';
import { S3ConfigService } from './s3-config.service';

type AwsSdk = typeof import('@aws-sdk/client-s3');

/**
 * Owns the S3 client lifecycle: lazy SDK import, single-flight init,
 * config-fingerprint tracking, and one-shot CORS auto-apply. Lives
 * separate from S3SyncBackend so that:
 *   - The SyncBackend itself is a thin pass-through to BlobStore + Repos
 *     (no SDK chunk imported eagerly into the backend file).
 *   - BlobStore impl can ask `getClient() / getSdk()` without owning
 *     auth lifecycle.
 *   - PR4 (GenericSyncBackend) can take a `ClientLifecycle` strategy
 *     and S3ClientService satisfies that contract.
 */
@Injectable({ providedIn: 'root' })
export class S3ClientService {
    private readonly cfg = inject(S3ConfigService);
    private readonly win = inject(WINDOW);

    /** Lazily-imported AWS SDK module. `import type` only at top; runtime
     *  `import()` happens on first `initAsync()`. */
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

    isAuthenticated(): boolean {
        return true; // Stateless: SigV4 signs each request from creds.
    }

    async authenticate(): Promise<void> {
        // No-op; AWS SDK signs each request with provided creds.
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
     * promise so a second caller can't destroy a client a first caller
     * just constructed.
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

    /** Throws if not yet initialised. Callers must `await initAsync()` first. */
    getClient(): S3Client {
        if (!this.client) throw new Error('S3 client not initialised — call initAsync() first.');
        return this.client;
    }
    getSdk(): AwsSdk {
        if (!this.sdk) throw new Error('S3 SDK not loaded — call initAsync() first.');
        return this.sdk;
    }
    getBucket(): string { return this.bucket; }
    getPrefix(): string { return this.prefix; }

    /**
     * Test arbitrary config without binding the singleton. Used by the
     * settings UI's "Test connection" button before saving. Builds a
     * throwaway client; doesn't touch instance state.
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
            client.destroy();
        }
    }

    /**
     * Idempotent best-effort: GET current bucket CORS, augment in place to
     * expose `x-amz-meta-last-active` on every existing rule (or write a
     * permissive default if none exist). Cached per backend-instance
     * lifetime — once we've decided yes or no, we don't retry until the
     * config changes.
     *
     * Returns true if the bucket is in a usable state at the end of this
     * call. Returns false if we couldn't read AND couldn't write — sync
     * stays correct via the GET-body fallback in BlobStore.list, just slower.
     */
    async ensureCorsApplied(): Promise<boolean> {
        if (this.corsAttempted) return this.corsOk;
        this.corsAttempted = true;
        if (!this.sdk || !this.client) {
            this.corsOk = false;
            return false;
        }
        this.corsOk = await this.applyCorsToBucket(this.sdk, this.client, this.bucket);
        return this.corsOk;
    }

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
                console.warn('[S3] GetBucketCors unexpected error; will try PUT anyway.', e);
            }
        }

        // If every existing rule already exposes our header, nothing to do.
        const allCovered = existingRules.length > 0 && existingRules.every(r =>
            (r.ExposeHeaders ?? []).some(h => h.toLowerCase() === targetLower)
        );
        if (allCovered) return true;

        const mergedRules = existingRules.length > 0
            ? existingRules.map(r => ({
                ...r,
                ExposeHeaders: (r.ExposeHeaders ?? []).some(h => h.toLowerCase() === targetLower)
                    ? r.ExposeHeaders
                    : [...(r.ExposeHeaders ?? []), targetHeader]
            }))
            : [{
                // Narrow to this app's origin — broad `*` would expose the
                // bucket's CORS surface to any site the user visits.
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

    /**
     * S3-specific NoSuchKey/404 detector. Used by repositories doing
     * "absent → null" reads.
     */
    isNotFound(err: unknown): boolean {
        if (this.sdk && err instanceof this.sdk.S3ServiceException) {
            return err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
        }
        return false;
    }
}
