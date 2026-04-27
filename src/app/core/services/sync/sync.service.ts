import { Injectable, inject, signal, computed } from '@angular/core';
import { StorageService } from '../storage.service';
import { SessionService } from '../session.service';
import { CollectionService } from '../collection.service';
import { Book, Collection, ROOT_COLLECTION_ID } from '../../models/types';
import { GDriveSyncBackend } from './gdrive-sync-backend';
import type { S3SyncBackend } from './s3-sync-backend';
import { SyncBackend, SyncBackendId, SyncResource, S3Config } from './sync.types';

async function loadS3Module() {
    return import('./s3-sync-backend');
}

const LS_BACKEND = 'sync_backend';
const LS_S3 = {
    endpoint: 'sync_s3_endpoint',
    region: 'sync_s3_region',
    bucket: 'sync_s3_bucket',
    accessKeyId: 'sync_s3_access_key',
    secretAccessKey: 'sync_s3_secret_key',
    prefix: 'sync_s3_prefix',
    forcePathStyle: 'sync_s3_path_style'
} as const;

const PENDING_DELETIONS_KEY: Record<SyncResource, string> = {
    book: 'pending_book_deletions',
    collection: 'pending_collection_deletions'
};

export interface SyncReport {
    uploaded: number;
    downloaded: number;
    deleted: number;
}

@Injectable({ providedIn: 'root' })
export class SyncService {
    private storage = inject(StorageService);
    private session = inject(SessionService);
    private collections = inject(CollectionService);
    private gdrive = inject(GDriveSyncBackend);

    activeBackendId = signal<SyncBackendId>(this.loadBackendId());
    s3Config = signal<S3Config | null>(this.loadS3Config());

    isS3Configured = computed(() => {
        const c = this.s3Config();
        return !!(c && c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
    });

    private s3Instance: S3SyncBackend | null = null;
    private s3InstanceFingerprint = '';

    setActiveBackend(id: SyncBackendId): void {
        this.activeBackendId.set(id);
        localStorage.setItem(LS_BACKEND, id);
    }

    saveS3Config(config: S3Config | null): void {
        if (config) {
            localStorage.setItem(LS_S3.endpoint, config.endpoint);
            localStorage.setItem(LS_S3.region, config.region);
            localStorage.setItem(LS_S3.bucket, config.bucket);
            localStorage.setItem(LS_S3.accessKeyId, config.accessKeyId);
            localStorage.setItem(LS_S3.secretAccessKey, config.secretAccessKey);
            if (config.prefix) localStorage.setItem(LS_S3.prefix, config.prefix);
            else localStorage.removeItem(LS_S3.prefix);
            localStorage.setItem(LS_S3.forcePathStyle, String(config.forcePathStyle ?? true));
        } else {
            for (const k of Object.values(LS_S3)) localStorage.removeItem(k);
        }
        this.s3Config.set(config);
        this.s3Instance = null;
        this.s3InstanceFingerprint = '';
    }

    /**
     * Returns the active backend instance. Throws if S3 is selected but unconfigured.
     * Async because the S3 backend is lazy-loaded to keep AWS SDK out of the initial bundle.
     */
    async getActiveBackend(): Promise<SyncBackend> {
        if (this.activeBackendId() === 's3') {
            return this.getS3Backend();
        }
        return this.gdrive;
    }

    getGDriveBackend(): SyncBackend {
        return this.gdrive;
    }

    async getS3Backend(): Promise<S3SyncBackend> {
        const cfg = this.s3Config();
        if (!cfg || !this.isS3Configured()) {
            throw new Error('S3 backend is not configured.');
        }
        const fp = JSON.stringify(cfg);
        if (!this.s3Instance || this.s3InstanceFingerprint !== fp) {
            const { S3SyncBackend } = await loadS3Module();
            this.s3Instance = new S3SyncBackend(cfg);
            this.s3InstanceFingerprint = fp;
        }
        return this.s3Instance;
    }

    /**
     * Builds an ephemeral S3 backend from the given config and runs HeadBucket.
     * Used by the settings UI to validate creds without persisting them.
     */
    async testS3Connection(config: S3Config): Promise<void> {
        const { S3SyncBackend } = await loadS3Module();
        const backend = new S3SyncBackend(config);
        await backend.testConnection();
    }

    /**
     * Records a pending deletion so it can be propagated on the next sync.
     */
    trackDeletion(resource: SyncResource, id: string): void {
        const key = PENDING_DELETIONS_KEY[resource];
        const list = this.readPendingList(key);
        if (!list.includes(id)) {
            list.push(id);
            localStorage.setItem(key, JSON.stringify(list));
        }
    }

    private readPendingList(key: string): string[] {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
        } catch {
            console.warn(`[SyncService] Corrupted pending list at ${key}, resetting.`);
            localStorage.removeItem(key);
            return [];
        }
    }

    /**
     * Two-way sync: collections first (so book.collectionId references resolve),
     * then books.
     */
    async syncAll(): Promise<SyncReport> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();

        const totals: SyncReport = { uploaded: 0, downloaded: 0, deleted: 0 };
        const downloadedBookIds = new Set<string>();

        for (const resource of ['collection', 'book'] as const) {
            const r = await this.syncResource(backend, resource, downloadedBookIds);
            totals.uploaded += r.uploaded;
            totals.downloaded += r.downloaded;
            totals.deleted += r.deleted;
        }

        // Refresh in-memory caches
        await this.collections.load();

        // Reload active session only if the active book itself was pulled from remote.
        const currentId = this.session.currentBookId();
        if (currentId && downloadedBookIds.has(currentId)) {
            console.log(`[SyncService] Post-sync: reloading active book ${currentId}`);
            await this.session.loadBook(currentId, false);
        }

        return totals;
    }

    private async syncResource(
        backend: SyncBackend,
        resource: SyncResource,
        downloadedBookIds: Set<string>
    ): Promise<SyncReport> {
        const report: SyncReport = { uploaded: 0, downloaded: 0, deleted: 0 };

        const localList: (Book | Collection)[] = resource === 'book'
            ? await this.storage.getBooks()
            : await this.storage.getCollections();
        const remoteList = await backend.list(resource);
        const remoteById = new Map(remoteList.map(r => [r.id, r]));
        const localById = new Map(localList.map(l => [l.id, l]));

        // Pending deletions: only drop from tracking when remote is confirmed gone.
        // A failed remove() stays in the list so the next sync retries.
        const deletionKey = PENDING_DELETIONS_KEY[resource];
        const pending = this.readPendingList(deletionKey);
        const remaining: string[] = [];
        for (const id of pending) {
            if (!remoteById.has(id)) {
                // Already absent on remote — nothing to do, drop from tracking.
                continue;
            }
            try {
                await backend.remove(resource, id);
                remoteById.delete(id);
                report.deleted++;
            } catch (e) {
                console.warn(`[SyncService] Failed to delete remote ${resource} ${id}, will retry`, e);
                remaining.push(id);
            }
        }
        localStorage.setItem(deletionKey, JSON.stringify(remaining));

        // Upload local → remote (per-item try/catch so one bad write doesn't kill the batch).
        for (const local of localList) {
            const remote = remoteById.get(local.id);
            const localTime = this.localTimestamp(local, resource);
            const needsUpload = !remote || localTime > remote.modifiedAt + 5000;
            if (!needsUpload) continue;
            try {
                await backend.write(resource, local.id, JSON.stringify(local));
                report.uploaded++;
            } catch (e) {
                console.warn(`[SyncService] Failed to upload ${resource} ${local.id}`, e);
            }
        }

        // Download remote → local (per-item try/catch).
        for (const remote of remoteList) {
            const local = localById.get(remote.id);
            const localTime = local ? this.localTimestamp(local, resource) : 0;
            if (local && remote.modifiedAt <= localTime + 5000) continue;
            try {
                const json = await backend.read(resource, remote.id);
                await this.applyRemote(resource, json);
                report.downloaded++;
                if (resource === 'book') downloadedBookIds.add(remote.id);
            } catch (e) {
                console.warn(`[SyncService] Failed to download ${resource} ${remote.id}`, e);
            }
        }

        return report;
    }

    private localTimestamp(item: Book | Collection, resource: SyncResource): number {
        return resource === 'book'
            ? (item as Book).lastActiveAt
            : (item as Collection).updatedAt;
    }

    private async applyRemote(resource: SyncResource, json: string): Promise<void> {
        if (resource === 'book') {
            const book = JSON.parse(json) as Book;
            // Backfill in case the remote was written by an older client.
            if (!book.collectionId) book.collectionId = ROOT_COLLECTION_ID;
            await this.storage.saveBook(book);
        } else {
            const collection = JSON.parse(json) as Collection;
            await this.storage.saveCollection(collection);
        }
    }

    /**
     * Pushes a settings JSON snapshot to the active backend.
     */
    async uploadSettings(content: string): Promise<void> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();
        await backend.writeSettings(content);
    }

    /**
     * Pulls the settings JSON snapshot from the active backend, or null if none.
     */
    async downloadSettings(): Promise<string | null> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();
        return backend.readSettings();
    }

    private loadBackendId(): SyncBackendId {
        const v = localStorage.getItem(LS_BACKEND);
        return v === 's3' ? 's3' : 'gdrive';
    }

    private loadS3Config(): S3Config | null {
        const endpoint = localStorage.getItem(LS_S3.endpoint);
        const bucket = localStorage.getItem(LS_S3.bucket);
        const accessKeyId = localStorage.getItem(LS_S3.accessKeyId);
        const secretAccessKey = localStorage.getItem(LS_S3.secretAccessKey);
        if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
        return {
            endpoint,
            region: localStorage.getItem(LS_S3.region) || 'us-east-1',
            bucket,
            accessKeyId,
            secretAccessKey,
            prefix: localStorage.getItem(LS_S3.prefix) || undefined,
            forcePathStyle: localStorage.getItem(LS_S3.forcePathStyle) !== 'false'
        };
    }
}
