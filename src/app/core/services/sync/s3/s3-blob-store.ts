import { Injectable, inject } from '@angular/core';
import { BlobListEntry, BlobListOptions, BlobMeta, BlobReadResult, BlobStore } from '../blob-store';
import { S3ClientService } from './s3-client.service';
import { createParallelPool } from '@app/core/utils/async.util';
import { SNAPSHOT_CONCURRENCY } from '../sync-snapshot-utils';

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);

/**
 * BlobStore over S3. Paths are relative to the configured bucket prefix:
 * `blob.write('books/abc.json', ...)` → S3 key `<configPrefix>books/abc.json`.
 *
 * `list()` ALWAYS includes object metadata in the result, even on S3 where
 * ListObjectsV2 doesn't return user metadata — N parallel HeadObject
 * requests recover it. This preserves the cost of the live SyncBackend.list
 * pre-refactor (which already does N HEADs).
 *
 * CORS auto-apply happens lazily on first list — cached on S3ClientService
 * per its lifetime.
 */
@Injectable({ providedIn: 'root' })
export class S3BlobStore implements BlobStore {
    private readonly clientSvc = inject(S3ClientService);

    private absKey(path: string): string {
        return `${this.clientSvc.getPrefix()}${path}`;
    }

    private toRelative(absKey: string): string {
        const prefix = this.clientSvc.getPrefix();
        return absKey.startsWith(prefix) ? absKey.slice(prefix.length) : absKey;
    }

    async list(prefix: string, options?: BlobListOptions): Promise<BlobListEntry[]> {
        await this.clientSvc.ensureCorsApplied();
        const sdk = this.clientSvc.getSdk();
        const client = this.clientSvc.getClient();
        const bucket = this.clientSvc.getBucket();
        const dirPrefix = this.absKey(prefix);
        const withMeta = options?.withMeta !== false;

        // Stage 1: enumerate keys via paginated ListObjectsV2.
        const partial: { absKey: string; modifiedAt: number; etag?: string; size?: number }[] = [];
        let continuationToken: string | undefined;
        do {
            const res = await client.send(new sdk.ListObjectsV2Command({
                Bucket: bucket,
                Prefix: dirPrefix,
                ContinuationToken: continuationToken
            }));
            for (const obj of res.Contents ?? []) {
                if (!obj.Key) continue;
                partial.push({
                    absKey: obj.Key,
                    modifiedAt: obj.LastModified ? obj.LastModified.getTime() : 0,
                    etag: obj.ETag,
                    size: obj.Size
                });
            }
            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);

        // Stage 2: HEAD each object in parallel to recover user metadata.
        // Skipped when caller opted out (`withMeta === false`) — saves N
        // round-trips when the consumer doesn't need meta (e.g. tombstones,
        // which encode `deletedAt` in the path).
        //
        // Browser CORS gotcha (when withMeta IS true): `x-amz-meta-*`
        // headers are stripped unless ExposeHeaders includes them.
        // ensureCorsApplied tries to fix it; if it failed, meta returns
        // empty — entry-mapper will fall back to GET-body or modifiedAt.
        if (!withMeta) {
            return partial.map(p => ({
                path: this.toRelative(p.absKey),
                meta: {},
                modifiedAt: p.modifiedAt,
                etag: p.etag,
                size: p.size
            }));
        }
        const entries: BlobListEntry[] = new Array(partial.length);
        await parallelPool(partial, async (p, i) => {
            entries[i] = await this.headForListEntry(p);
        });
        return entries;
    }

    private async headForListEntry(p: {
        absKey: string; modifiedAt: number; etag?: string; size?: number;
    }): Promise<BlobListEntry> {
        const sdk = this.clientSvc.getSdk();
        const client = this.clientSvc.getClient();
        const bucket = this.clientSvc.getBucket();
        const fallback: BlobListEntry = {
            path: this.toRelative(p.absKey),
            meta: {},
            modifiedAt: p.modifiedAt,
            etag: p.etag,
            size: p.size
        };
        try {
            const head = await client.send(new sdk.HeadObjectCommand({
                Bucket: bucket, Key: p.absKey
            }));
            return { ...fallback, meta: { ...(head.Metadata ?? {}) } };
        } catch {
            return fallback;
        }
    }

    async read(path: string): Promise<BlobReadResult> {
        const sdk = this.clientSvc.getSdk();
        const client = this.clientSvc.getClient();
        const res = await client.send(new sdk.GetObjectCommand({
            Bucket: this.clientSvc.getBucket(),
            Key: this.absKey(path),
            // Cache-Control: no-store → Chrome's HTTP disk cache won't serve
            // stale bodies on subsequent GETs (heuristic freshness off
            // Last-Modified would otherwise mask post-PUT updates inside
            // the cache window).
            ResponseCacheControl: 'no-store'
        }));
        if (!res.Body) throw new Error(`S3: empty body for ${path}`);
        const text = await res.Body.transformToString();
        return {
            text,
            meta: { ...(res.Metadata ?? {}) },
            etag: res.ETag,
            modifiedAt: res.LastModified ? res.LastModified.getTime() : 0,
            size: res.ContentLength
        };
    }

    async write(path: string, text: string, meta?: BlobMeta): Promise<void> {
        const sdk = this.clientSvc.getSdk();
        const client = this.clientSvc.getClient();
        await client.send(new sdk.PutObjectCommand({
            Bucket: this.clientSvc.getBucket(),
            Key: this.absKey(path),
            Body: text,
            ContentType: this.contentTypeFor(path),
            ...(meta ? { Metadata: { ...meta } } : {})
        }));
    }

    async remove(path: string): Promise<void> {
        const sdk = this.clientSvc.getSdk();
        const client = this.clientSvc.getClient();
        await client.send(new sdk.DeleteObjectCommand({
            Bucket: this.clientSvc.getBucket(),
            Key: this.absKey(path)
        }));
    }

    async copy(srcPath: string, dstPath: string): Promise<void> {
        const sdk = this.clientSvc.getSdk();
        const client = this.clientSvc.getClient();
        const bucket = this.clientSvc.getBucket();
        const srcAbs = this.absKey(srcPath);
        // CopySource must be URL-encoded for non-ASCII / spaces.
        const copySource = encodeURIComponent(`${bucket}/${srcAbs}`).replace(/%2F/g, '/');
        await client.send(new sdk.CopyObjectCommand({
            Bucket: bucket,
            CopySource: copySource,
            Key: this.absKey(dstPath),
            // Preserve user metadata (last-active, etc.) from the source.
            MetadataDirective: 'COPY'
        }));
    }

    async exists(path: string): Promise<boolean> {
        const sdk = this.clientSvc.getSdk();
        const client = this.clientSvc.getClient();
        try {
            await client.send(new sdk.HeadObjectCommand({
                Bucket: this.clientSvc.getBucket(),
                Key: this.absKey(path)
            }));
            return true;
        } catch (e) {
            if (this.clientSvc.isNotFound(e)) return false;
            throw e;
        }
    }

    private contentTypeFor(path: string): string {
        // .json paths get application/json; everything else (e.g. tombstone
        // marker objects with no extension) gets octet-stream so CDNs and
        // proxies don't try to "interpret" them.
        return path.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    }
}
