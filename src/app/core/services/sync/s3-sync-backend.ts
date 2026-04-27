import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    HeadBucketCommand,
    S3ServiceException
} from '@aws-sdk/client-s3';
import { SyncBackend, SyncResource, RemoteEntry, SyncBackendId, S3Config } from './sync.types';

const RESOURCE_DIR: Record<SyncResource, string> = {
    book: 'books',
    collection: 'collections'
};
const SETTINGS_KEY = 'settings.json';

export class S3SyncBackend implements SyncBackend {
    readonly id: SyncBackendId = 's3';
    readonly label = 'S3-compatible';
    readonly isConfigured = true;

    private client: S3Client;
    private bucket: string;
    private prefix: string;

    constructor(private config: S3Config) {
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
     * Lightweight reachability check. Use from settings UI to validate creds.
     */
    async testConnection(): Promise<void> {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    }

    private keyFor(resource: SyncResource, id: string): string {
        return `${this.prefix}${RESOURCE_DIR[resource]}/${id}.json`;
    }

    private settingsKey(): string {
        return `${this.prefix}${SETTINGS_KEY}`;
    }

    async list(resource: SyncResource): Promise<RemoteEntry[]> {
        const dirPrefix = `${this.prefix}${RESOURCE_DIR[resource]}/`;
        const entries: RemoteEntry[] = [];
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
                entries.push({
                    id,
                    modifiedAt: obj.LastModified ? obj.LastModified.getTime() : 0,
                    etag: obj.ETag
                });
            }

            continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (continuationToken);

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

    async write(resource: SyncResource, id: string, json: string): Promise<void> {
        await this.client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.keyFor(resource, id),
            Body: json,
            ContentType: 'application/json'
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

    private isNotFound(err: unknown): boolean {
        if (err instanceof S3ServiceException) {
            return err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404;
        }
        return false;
    }
}
