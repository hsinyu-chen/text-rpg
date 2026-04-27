export type SyncBackendId = 'gdrive' | 's3';

export type SyncResource = 'book' | 'collection';

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

    readSettings(): Promise<string | null>;
    writeSettings(content: string): Promise<void>;
    readPrompts(): Promise<string | null>;
    writePrompts(content: string): Promise<void>;
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
