import { Injectable, inject, signal, computed, effect } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { StorageService } from '../storage.service';
import { SessionService } from '../session.service';
import { CollectionService } from '../collection.service';
import { GameStateService } from '../game-state.service';
import { Book, Collection, ROOT_COLLECTION_ID } from '../../models/types';
import { GDriveSyncBackend } from './gdrive-sync-backend';
import type { S3SyncBackend } from './s3-sync-backend';
import { SyncBackend, SyncBackendId, SyncResource, S3Config, SyncConflict } from './sync.types';

async function loadS3Module() {
    return import('./s3-sync-backend');
}

const LS_BACKEND = 'sync_backend';
const LS_AUTO_PREFIX = 'sync_auto_';
// Two baselines per resource id: local-clock and cloud-clock. Both must compare
// against same-domain values, so we never mix `Date.now()` (device) with
// `LastModified` (server) in a single inequality.
const LS_LOCAL_BASE_PREFIX = 'sync_lb_';
const LS_REMOTE_BASE_PREFIX = 'sync_rb_';
const LS_DIRTY = 'sync_dirty';
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

const DEBOUNCE_MS = 60_000;
const VISIBILITY_COOLDOWN_MS = 30_000;
const MAX_FAILURES = 3;
const TS_SLACK_MS = 5_000;

export interface SyncReport {
    uploaded: number;
    downloaded: number;
    deleted: number;
    conflicts?: SyncConflict[];
}

export interface RemoteUpdateAvailable {
    bookId: string;
    remoteModifiedAt: number;
}

@Injectable({ providedIn: 'root' })
export class SyncService {
    private storage = inject(StorageService);
    private session = inject(SessionService);
    private collections = inject(CollectionService);
    private gdrive = inject(GDriveSyncBackend);
    private state = inject(GameStateService);
    private snackBar = inject(MatSnackBar);

    activeBackendId = signal<SyncBackendId>(this.loadBackendId());
    s3Config = signal<S3Config | null>(this.loadS3Config());

    isS3Configured = computed(() => {
        const c = this.s3Config();
        return !!(c && c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
    });

    /**
     * Per-backend auto-sync preference. Only meaningful for backends with
     * supportsBackgroundSync = true.
     */
    autoSyncEnabled = signal<Record<SyncBackendId, boolean>>(this.loadAutoFlags());

    /**
     * Set when a sync downloaded a newer version of the currently active book
     * AND the local copy had no unsynced edits. UI should toast a "load new version" prompt.
     */
    remoteUpdateAvailable = signal<RemoteUpdateAvailable | null>(null);

    /**
     * Conflicts detected during sync (both sides edited since last sync).
     * UI should drain this signal — show toast per item, then reset to [].
     */
    conflicts = signal<SyncConflict[]>([]);

    private s3Instance: S3SyncBackend | null = null;
    private s3InstanceFingerprint = '';

    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private inFlight: Promise<SyncReport> | null = null;
    private lastSyncAt = 0;
    private failureCount = 0;
    private isInitialSync = false;

    constructor() {
        // React to every successful book save → schedule debounced auto-sync.
        effect(() => {
            const ts = this.session.lastSavedAt();
            if (ts > 0) this.scheduleAutoSync();
        });

        // visibilitychange: hidden → flush; visible → schedule with cooldown
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') {
                    void this.flushAutoSync();
                } else if (document.visibilityState === 'visible') {
                    if (Date.now() - this.lastSyncAt > VISIBILITY_COOLDOWN_MS) {
                        this.scheduleAutoSync(true);
                    }
                }
            });
        }
        // pagehide: if a debounce was pending, mark dirty so next boot picks it up
        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', () => {
                if (this.debounceTimer) {
                    localStorage.setItem(LS_DIRTY, '1');
                }
            });
        }
    }

    setActiveBackend(id: SyncBackendId): void {
        this.activeBackendId.set(id);
        localStorage.setItem(LS_BACKEND, id);
        this.cancelDebounce();
        this.failureCount = 0;
    }

    setAutoSyncEnabled(id: SyncBackendId, on: boolean): void {
        const next = { ...this.autoSyncEnabled(), [id]: on };
        this.autoSyncEnabled.set(next);
        localStorage.setItem(LS_AUTO_PREFIX + id, on ? '1' : '0');
        this.failureCount = 0;
        if (!on) this.cancelDebounce();
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
        this.failureCount = 0;
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
        // Local copy is gone — drop its baselines so the entry doesn't linger.
        this.clearBaselines(resource, id);
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
     * Whether auto-sync is *effectively* enabled right now: backend supports it,
     * user toggled it on, and (for S3) it's configured. Drive is permanently false
     * because Background Sync requires interactive auth.
     */
    isAutoSyncActive(): boolean {
        const id = this.activeBackendId();
        const flag = this.autoSyncEnabled()[id];
        if (!flag) return false;
        if (id === 'gdrive') return false; // capability gate
        if (id === 's3') return this.isS3Configured();
        return false;
    }

    /**
     * Schedules a debounced background sync. No-op if auto-sync isn't active,
     * or if currently generating (avoid uploading mid-stream).
     * @param immediate If true, runs without debounce delay (still queued via setTimeout 0).
     */
    scheduleAutoSync(immediate = false): void {
        if (!this.isAutoSyncActive()) return;
        if (this.failureCount >= MAX_FAILURES) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        const delay = immediate ? 0 : DEBOUNCE_MS;
        this.debounceTimer = setTimeout(() => this.runAutoSync(), delay);
    }

    /**
     * Cancels any pending debounce and runs a sync immediately, but only if one
     * was actually scheduled. Used by visibilitychange=hidden to flush before tab close.
     */
    async flushAutoSync(): Promise<void> {
        if (!this.debounceTimer) return;
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
        await this.runAutoSync();
    }

    private cancelDebounce(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    private async runAutoSync(): Promise<void> {
        this.debounceTimer = null;
        if (!this.isAutoSyncActive()) return;
        if (this.state.status() === 'generating') {
            // Re-queue; we'll try again after the turn completes (next saveBook).
            return;
        }
        try {
            await this.syncAll();
            this.failureCount = 0;
        } catch (e) {
            this.failureCount++;
            console.warn(`[SyncService] Auto-sync failed (${this.failureCount}/${MAX_FAILURES})`, e);
            if (this.failureCount >= MAX_FAILURES) {
                const id = this.activeBackendId();
                this.setAutoSyncEnabled(id, false);
                this.snackBar.open(
                    `Auto-sync disabled after ${MAX_FAILURES} failures. Re-enable in Settings once fixed.`,
                    'Close',
                    { duration: 8000 }
                );
            }
        }
    }

    /**
     * One-shot cleanup of the v1 single-baseline keys (sync_at_*) that the
     * earlier broken iteration of this code wrote. Those values cross device
     * and cloud clock domains; leaving them in place would keep firing false
     * conflicts. Safe to remove unconditionally — the v2 baselines repopulate
     * after the next successful sync.
     */
    private dropLegacyBaselines(): void {
        const drop: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('sync_at_')) drop.push(k);
        }
        for (const k of drop) localStorage.removeItem(k);
        if (drop.length) console.log(`[SyncService] Dropped ${drop.length} legacy single-baseline keys`);
    }

    /**
     * Boot-time sync. Runs syncAll with the "initial" flag so newer remote versions
     * are silently reloaded into the active session (no toast — there's nothing to interrupt).
     * Also drains the dirty flag from a previous tab close.
     */
    async bootSync(): Promise<void> {
        this.dropLegacyBaselines();
        if (!this.isAutoSyncActive()) {
            // Even if auto-sync is off, honour an explicit dirty flag (set on pagehide
            // when a debounce was pending). We don't know which backend to use though,
            // so just clear the flag — manual sync still works.
            localStorage.removeItem(LS_DIRTY);
            return;
        }
        this.isInitialSync = true;
        try {
            await this.syncAll();
            this.failureCount = 0;
            localStorage.removeItem(LS_DIRTY);
        } catch (e) {
            this.failureCount++;
            console.warn('[SyncService] Boot sync failed', e);
        } finally {
            this.isInitialSync = false;
        }
    }

    /**
     * Two-way sync: collections first (so book.collectionId references resolve),
     * then books. Concurrency guard: if a sync is already in flight, return its promise.
     */
    syncAll(): Promise<SyncReport> {
        if (this.inFlight) return this.inFlight;
        this.inFlight = this.doSyncAll().finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    private async doSyncAll(): Promise<SyncReport> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();

        const totals: SyncReport = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [] };
        const downloadedBookIds = new Set<string>();

        for (const resource of ['collection', 'book'] as const) {
            const r = await this.syncResource(backend, resource, downloadedBookIds);
            totals.uploaded += r.uploaded;
            totals.downloaded += r.downloaded;
            totals.deleted += r.deleted;
            if (r.conflicts?.length) totals.conflicts!.push(...r.conflicts);
        }

        // Refresh in-memory caches
        await this.collections.load();

        // Decide reload behaviour for the active book. Boot is silent (nothing to
        // interrupt); all other syncs surface a toast so the user controls reload.
        const currentId = this.session.currentBookId();
        if (currentId && downloadedBookIds.has(currentId)) {
            if (this.isInitialSync) {
                console.log(`[SyncService] Post-sync: silent reload of active book ${currentId}`);
                await this.session.loadBook(currentId, false);
            } else {
                const remote = await this.storage.getBook(currentId);
                this.remoteUpdateAvailable.set({
                    bookId: currentId,
                    remoteModifiedAt: remote?.lastActiveAt ?? Date.now()
                });
            }
        }

        if (totals.conflicts && totals.conflicts.length > 0) {
            this.conflicts.update(prev => [...prev, ...totals.conflicts!]);
        }

        this.lastSyncAt = Date.now();
        return totals;
    }

    private async syncResource(
        backend: SyncBackend,
        resource: SyncResource,
        downloadedBookIds: Set<string>
    ): Promise<SyncReport> {
        const report: SyncReport = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: [] };

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
        // Note: the inequality below mixes device clock and cloud clock — that's a
        // pre-existing limitation of the simple "newer wins" rule. We don't try to
        // fix it here; we only ensure conflict detection (below) doesn't compound it.
        for (const local of localList) {
            const remote = remoteById.get(local.id);
            const localTime = this.localTimestamp(local, resource);
            const needsUpload = !remote || localTime > remote.modifiedAt + TS_SLACK_MS;
            if (!needsUpload) continue;
            try {
                await backend.write(resource, local.id, JSON.stringify(local));
                // After upload, local is in sync from the device's perspective.
                // We DON'T touch remoteBaseline here because we don't know cloud's
                // new modifiedAt without an extra HEAD request — the next sync
                // will refresh it. Worst case: one redundant download of our own
                // upload, which costs a single GET. Acceptable.
                this.setLocalBaseline(resource, local.id, localTime);
                report.uploaded++;
            } catch (e) {
                console.warn(`[SyncService] Failed to upload ${resource} ${local.id}`, e);
            }
        }

        // Download remote → local (per-item try/catch).
        for (const remote of remoteList) {
            const local = localById.get(remote.id);
            const localTime = local ? this.localTimestamp(local, resource) : 0;
            if (local && remote.modifiedAt <= localTime + TS_SLACK_MS) continue;

            // Conflict detection — only meaningful when BOTH baselines exist
            // (i.e., this device has previously completed a successful sync of
            // this entity). On first encounter we fall through to the simple
            // "remote newer → download" path; nothing to conflict against.
            const localBase = this.getLocalBaseline(resource, remote.id);
            const remoteBase = this.getRemoteBaseline(resource, remote.id);
            if (local && localBase > 0 && remoteBase > 0) {
                const localDirty = localTime > localBase + TS_SLACK_MS;
                const remoteDirty = remote.modifiedAt > remoteBase + TS_SLACK_MS;
                if (localDirty && remoteDirty) {
                    console.warn(`[SyncService] Conflict on ${resource} ${remote.id} — local edits preserved`);
                    report.conflicts!.push({
                        resource,
                        id: remote.id,
                        localTime,
                        remoteTime: remote.modifiedAt,
                        name: this.entityName(local, resource)
                    });
                    continue;
                }
            }

            try {
                const json = await backend.read(resource, remote.id);
                await this.applyRemote(resource, json);
                // After a clean download both sides are aligned; we know the
                // exact local-domain timestamp from the downloaded payload and
                // the cloud-domain timestamp from the listing. Set both.
                const downloaded = JSON.parse(json) as Book | Collection;
                this.setBaselines(
                    resource,
                    remote.id,
                    this.localTimestamp(downloaded, resource),
                    remote.modifiedAt
                );
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

    private entityName(item: Book | Collection, resource: SyncResource): string {
        return resource === 'book' ? (item as Book).name : (item as Collection).name;
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
     * Downloads the remote version of a book and stores it as a NEW local book
     * with a fresh ID and a "(cloud)" suffix. Used to escape conflicts without
     * data loss: the local original keeps its ID and edits, the cloud version
     * arrives as a sibling for manual comparison.
     * @returns the new local book ID.
     */
    async forkRemoteBook(bookId: string): Promise<string> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();
        const json = await backend.read('book', bookId);
        const remoteBook = JSON.parse(json) as Book;

        const newId = crypto.randomUUID();
        const forked: Book = {
            ...remoteBook,
            id: newId,
            name: `${remoteBook.name || 'Untitled'} (cloud)`,
            collectionId: remoteBook.collectionId || ROOT_COLLECTION_ID,
            createdAt: Date.now(),
            lastActiveAt: Date.now()
        };
        await this.storage.saveBook(forked);

        // No baselines: the fork has a brand-new ID with no prior cloud history,
        // so it'll be treated as a first-encounter local-only book on next sync
        // (i.e., uploaded fresh).
        this.clearBaselines('book', newId);
        return newId;
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

    private getLocalBaseline(resource: SyncResource, id: string): number {
        const raw = localStorage.getItem(LS_LOCAL_BASE_PREFIX + resource + '_' + id);
        return raw ? Number(raw) || 0 : 0;
    }

    private getRemoteBaseline(resource: SyncResource, id: string): number {
        const raw = localStorage.getItem(LS_REMOTE_BASE_PREFIX + resource + '_' + id);
        return raw ? Number(raw) || 0 : 0;
    }

    private setLocalBaseline(resource: SyncResource, id: string, ts: number): void {
        if (ts > 0) localStorage.setItem(LS_LOCAL_BASE_PREFIX + resource + '_' + id, String(ts));
    }

    private setBaselines(resource: SyncResource, id: string, localTs: number, remoteTs: number): void {
        if (localTs > 0) localStorage.setItem(LS_LOCAL_BASE_PREFIX + resource + '_' + id, String(localTs));
        if (remoteTs > 0) localStorage.setItem(LS_REMOTE_BASE_PREFIX + resource + '_' + id, String(remoteTs));
    }

    private clearBaselines(resource: SyncResource, id: string): void {
        localStorage.removeItem(LS_LOCAL_BASE_PREFIX + resource + '_' + id);
        localStorage.removeItem(LS_REMOTE_BASE_PREFIX + resource + '_' + id);
    }

    private loadBackendId(): SyncBackendId {
        const v = localStorage.getItem(LS_BACKEND);
        return v === 's3' ? 's3' : 'gdrive';
    }

    private loadAutoFlags(): Record<SyncBackendId, boolean> {
        return {
            gdrive: localStorage.getItem(LS_AUTO_PREFIX + 'gdrive') === '1',
            s3: localStorage.getItem(LS_AUTO_PREFIX + 's3') === '1'
        };
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
