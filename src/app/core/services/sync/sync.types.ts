export type SyncBackendId = 'gdrive' | 's3';

export type SyncResource = 'book' | 'collection';

export interface RemoteEntry {
    id: string;
    modifiedAt: number; // unix ms
    etag?: string;
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
    write(resource: SyncResource, id: string, json: string): Promise<void>;
    remove(resource: SyncResource, id: string): Promise<void>;

    readSettings(): Promise<string | null>;
    writeSettings(content: string): Promise<void>;
}

export interface SyncConflict {
    resource: SyncResource;
    id: string;
    localTime: number;
    remoteTime: number;
    /** Human-readable name from the local copy, for UI prompts. */
    name?: string;
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
