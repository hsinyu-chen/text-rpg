import { Injectable, DestroyRef, inject, signal, computed, effect } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { MatSnackBar } from '@angular/material/snack-bar';
import { WINDOW } from '../../tokens/window.token';
import { StorageService } from '../storage.service';
import { SessionService } from '../session.service';
import { CollectionService } from '../collection.service';
import { GameStateService } from '../game-state.service';
import { Book, Collection, ROOT_COLLECTION_ID } from '../../models/types';
import { GDriveSyncBackend } from './gdrive-sync-backend';
import type { S3SyncBackend } from './s3-sync-backend';
import { FileSyncBackend } from './file-sync-backend';
import {
    SyncBackend, SyncBackendId, SyncResource, S3Config,
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotLocalPayload,
    SnapshotTrigger
} from './sync.types';
import { cleanBookForSync, cleanCollectionForSync } from './clean.util';
import { BUILT_IN_PROFILES } from '../../constants/prompt-profiles';
import { PromptProfileRegistryService } from '../prompt-profile-registry.service';
import { ALL_PROMPT_TYPES, type PromptType } from '../injection.service';

const PROMPT_TYPES = ALL_PROMPT_TYPES;

interface PromptsV2 {
    version: 2;
    profiles: {
        id: string;
        displayName: string;
        baseProfileId: string;
        createdAt: number;
        updatedAt: number;
    }[];
    prompts: Record<string, { content: string; tokens?: number }>;
}

function isPromptsV2(x: unknown): x is PromptsV2 {
    if (!x || typeof x !== 'object') return false;
    const v = (x as { version?: unknown }).version;
    return v === 2;
}

function importSuffix(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    }
    return Math.random().toString(36).slice(2, 10);
}

function isValidUserProfileId(id: unknown): id is string {
    // Untrimmed: leading / trailing whitespace must fail outright since the
    // raw id ends up as an IDB key + registry entry verbatim.
    return typeof id === 'string' && /^[A-Za-z0-9_-]{3,}$/.test(id);
}

async function loadS3Module() {
    return import('./s3-sync-backend');
}

function errMsg(e: unknown): string {
    if (e instanceof Error) return e.message;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
        return (e as { message: string }).message;
    }
    return String(e);
}

const LS_BACKEND = 'sync_backend';
const LS_AUTO_PREFIX = 'sync_auto_';
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

const LS_DEVICE_ID = 'sync_device_id';
/**
 * Cap on the number of auto-trigger snapshots kept on the cloud. Manual
 * snapshots are always preserved (the user pressed a button on purpose).
 * Anything beyond this cap, sorted oldest-first, is deleted on the next
 * createSnapshot success.
 */
const SNAPSHOT_AUTO_RETENTION = 20;
const RETENTION_DELETE_CONCURRENCY = 4;

export interface SyncError {
    resource: SyncResource;
    id: string;
    op: 'upload' | 'download' | 'delete' | 'list';
    message: string;
}

export interface SyncReport {
    uploaded: number;
    downloaded: number;
    deleted: number;
    errors: SyncError[];
}

export interface ForcePushReport { uploaded: number; deletedRemote: number; errors: SyncError[]; }
export interface ForcePullReport { downloaded: number; deletedLocal: number; errors: SyncError[]; }

export interface RemoteUpdateAvailable {
    bookId: string;
    remoteModifiedAt: number;
}

/**
 * Thrown when the pre-op safety snapshot for forcePush / forcePull /
 * restore fails. The UI catches this to ask "snapshot failed — continue
 * anyway?", then re-invokes the same op with `skipSnapshot: true` /
 * `skipPreRestoreSnapshot: true`.
 */
export class SnapshotPreOpError extends Error {
    readonly trigger: 'forcePush' | 'forcePull' | 'preRestore';
    constructor(trigger: 'forcePush' | 'forcePull' | 'preRestore', message: string) {
        super(`Pre-${trigger} snapshot failed: ${message}`);
        this.name = 'SnapshotPreOpError';
        this.trigger = trigger;
    }
}

@Injectable({ providedIn: 'root' })
export class SyncService {
    private storage = inject(StorageService);
    private session = inject(SessionService);
    private collections = inject(CollectionService);
    private gdrive = inject(GDriveSyncBackend);
    private file = inject(FileSyncBackend);
    private state = inject(GameStateService);
    private profileRegistry = inject(PromptProfileRegistryService);
    private snackBar = inject(MatSnackBar);
    private readonly doc = inject(DOCUMENT);
    private readonly win = inject(WINDOW);
    private readonly destroyRef = inject(DestroyRef);

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
     * Set when a non-boot sync downloaded a newer version of the active book.
     * The toast prompts the user to load it; we don't silently swap because
     * the user might be mid-typing.
     */
    remoteUpdateAvailable = signal<RemoteUpdateAvailable | null>(null);

    private s3Instance: S3SyncBackend | null = null;
    private s3InstanceFingerprint = '';

    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private inFlight: { kind: 'sync' | 'forcePush' | 'forcePull' | 'restore'; promise: Promise<unknown> } | null = null;
    /**
     * Set true while restoreSnapshot is rewriting state. Auto-sync would
     * race with the restore (its in-flight reads / writes get mixed in,
     * potentially propagating mid-restore garbage to other devices), so we
     * gate `isAutoSyncActive()` on this flag and refuse to schedule new
     * runs until restore is done.
     */
    private restoreInProgress = false;
    /**
     * Per-process cap on self-heal re-uploads. If a backend mutates the
     * `last-active` metadata it round-trips (truncation, precision change,
     * proxy rewrite, etc.) we'd otherwise loop forever: download → mismatch
     * → re-upload → next sync's list() reports the mutated value again →
     * mismatch → re-upload. Once we've self-healed an id this session, we
     * trust it; any *real* drift that re-emerges later will flow through
     * the regular newer-wins path on the next process restart.
     */
    private selfHealedIds = new Set<string>();
    private lastSyncAt = 0;
    private failureCount = 0;
    private isInitialSync = false;

    constructor() {
        // React to every successful book save → schedule debounced auto-sync.
        effect(() => {
            const ts = this.session.lastSavedAt();
            if (ts > 0) this.scheduleAutoSync();
        });

        // Listeners are kept alive for the entire app lifetime in production
        // (the service is providedIn: 'root'), but tests recreate the service
        // and would otherwise leak listeners onto the shared document/window.
        const onVisibilityChange = () => {
            if (this.doc.visibilityState === 'hidden') {
                void this.flushAutoSync();
            } else if (this.doc.visibilityState === 'visible') {
                if (Date.now() - this.lastSyncAt > VISIBILITY_COOLDOWN_MS) {
                    this.scheduleAutoSync(true);
                }
            }
        };
        const onPageHide = () => {
            if (this.debounceTimer) {
                localStorage.setItem(LS_DIRTY, '1');
            }
        };
        this.doc.addEventListener('visibilitychange', onVisibilityChange);
        this.win.addEventListener('pagehide', onPageHide);
        this.destroyRef.onDestroy(() => {
            this.doc.removeEventListener('visibilitychange', onVisibilityChange);
            this.win.removeEventListener('pagehide', onPageHide);
        });
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

    async getActiveBackend(): Promise<SyncBackend> {
        const id = this.activeBackendId();
        if (id === 's3') return this.getS3Backend();
        if (id === 'file') return this.file;
        return this.gdrive;
    }

    getFileBackend(): FileSyncBackend {
        return this.file;
    }

    isFileBackendBound(): boolean {
        return this.file.permission.handle() !== null;
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
            this.s3Instance = new S3SyncBackend(cfg, this.win.location.origin);
            this.s3InstanceFingerprint = fp;
        }
        return this.s3Instance;
    }

    async testS3Connection(config: S3Config): Promise<void> {
        const { S3SyncBackend } = await loadS3Module();
        const backend = new S3SyncBackend(config, this.win.location.origin);
        await backend.testConnection();
    }

    /**
     * Records a pending deletion so it can be propagated on the next sync.
     */
    trackDeletion(resource: SyncResource, id: string): void {
        const key = PENDING_DELETIONS_KEY[resource];
        const list = this.readPendingList(key);
        // Capture deletedAt at delete-time, not at sync-time. If sync fails
        // and retries, the timestamp must NOT advance — otherwise a retry
        // could later clobber a legitimate post-delete edit on another
        // device. Same id deleted twice (re-add then delete) updates the
        // timestamp; that's the correct latest-delete semantics.
        const idx = list.findIndex(e => e.id === id);
        const entry = { id, deletedAt: Date.now() };
        if (idx === -1) list.push(entry);
        else list[idx] = entry;
        localStorage.setItem(key, JSON.stringify(list));
    }

    private readPendingList(key: string): { id: string; deletedAt: number }[] {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            const now = Date.now();
            return parsed.flatMap(x => {
                if (typeof x === 'string') return [{ id: x, deletedAt: now }];
                if (x && typeof x === 'object' && typeof x.id === 'string') {
                    return [{ id: x.id, deletedAt: Number(x.deletedAt) || now }];
                }
                return [];
            });
        } catch {
            console.warn(`[SyncService] Corrupted pending list at ${key}, resetting.`);
            localStorage.removeItem(key);
            return [];
        }
    }

    isAutoSyncActive(): boolean {
        if (this.restoreInProgress) return false;
        const id = this.activeBackendId();
        const flag = this.autoSyncEnabled()[id];
        if (!flag) return false;
        if (id === 'gdrive') return false;
        if (id === 's3') return this.isS3Configured();
        return false;
    }

    scheduleAutoSync(immediate = false): void {
        if (!this.isAutoSyncActive()) return;
        if (this.failureCount >= MAX_FAILURES) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        const delay = immediate ? 0 : DEBOUNCE_MS;
        this.debounceTimer = setTimeout(() => this.runAutoSync(), delay);
    }

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
        if (this.state.status() === 'generating') return;
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
     * One-shot cleanup of the legacy baseline keys (sync_at_*, sync_lb_*,
     * sync_rb_*) that the time-baseline iteration of this code wrote. The
     * newer-wins design doesn't need any of them; leaving them in place is
     * harmless but they'd accumulate forever.
     */
    private dropLegacyBaselines(): void {
        const drop: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k) continue;
            if (k.startsWith('sync_at_') || k.startsWith('sync_lb_') || k.startsWith('sync_rb_')) {
                drop.push(k);
            }
        }
        for (const k of drop) localStorage.removeItem(k);
        if (drop.length) console.log(`[SyncService] Dropped ${drop.length} legacy baseline keys`);
    }

    /**
     * Boot-time sync. Runs syncAll with the "initial" flag so newer remote
     * versions are silently reloaded into the active session. Also drains the
     * dirty flag from a previous tab close.
     */
    async bootSync(): Promise<void> {
        this.dropLegacyBaselines();
        if (!this.isAutoSyncActive()) {
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
        // Coalesce concurrent syncAll() callers onto the same promise. If a
        // force operation is in flight instead, queue behind it rather than
        // returning its promise — the report types differ and casting would
        // corrupt the caller's view.
        const cur = this.inFlight;
        if (cur?.kind === 'sync') return cur.promise as Promise<SyncReport>;
        return this.runExclusive('sync', () => this.doSyncAll());
    }

    private async runExclusive<T>(
        kind: 'sync' | 'forcePush' | 'forcePull' | 'restore',
        fn: () => Promise<T>
    ): Promise<T> {
        while (this.inFlight) {
            try { await this.inFlight.promise; } catch { /* prior op's caller handles */ }
        }
        const promise = fn();
        const slot = { kind, promise };
        this.inFlight = slot;
        promise.finally(() => {
            if (this.inFlight === slot) this.inFlight = null;
        });
        return promise;
    }

    private async doSyncAll(): Promise<SyncReport> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();

        const totals: SyncReport = { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };
        const downloadedBookIds = new Set<string>();
        const deletedBookIds = new Set<string>();

        for (const resource of ['collection', 'book'] as const) {
            const r = await this.syncResource(backend, resource, downloadedBookIds, deletedBookIds);
            totals.uploaded += r.uploaded;
            totals.downloaded += r.downloaded;
            totals.deleted += r.deleted;
            totals.errors.push(...r.errors);
        }

        await this.collections.load();

        const currentId = this.session.currentBookId();
        if (currentId && deletedBookIds.has(currentId)) {
            // The active book was wiped by a tombstone from another device.
            // Switch to the most-recently-active remaining book, or clear
            // the session if nothing's left.
            const remaining = await this.storage.getBooks();
            if (remaining.length > 0) {
                const sorted = [...remaining].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
                await this.session.loadBook(sorted[0].id, false);
            } else {
                await this.session.unloadCurrentSession(false);
            }
        } else if (currentId && downloadedBookIds.has(currentId)) {
            // Active book was downloaded (but not deleted). On boot we silently
            // reload; at runtime we surface a toast so we don't wipe the
            // user's open session.
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

        this.lastSyncAt = Date.now();
        return totals;
    }

    private async syncResource(
        backend: SyncBackend,
        resource: SyncResource,
        downloadedBookIds: Set<string>,
        deletedBookIds: Set<string>
    ): Promise<SyncReport> {
        const report: SyncReport = { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };

        let localList: (Book | Collection)[] = resource === 'book'
            ? await this.storage.getBooks()
            : await this.storage.getCollections();
        const remoteList = await backend.list(resource);
        const remoteById = new Map(remoteList.map(r => [r.id, r]));
        const localById = new Map(localList.map(l => [l.id, l]));

        // Pending deletions: write a tombstone (or update the existing one)
        // so other devices see the deletion, then drop the live object. Only
        // remove from the local tracking list once both succeed.
        // Use the deletedAt captured at delete-time — NOT Date.now() — so a
        // retry doesn't advance the timestamp and clobber a legitimate
        // post-delete edit on another device.
        const deletionKey = PENDING_DELETIONS_KEY[resource];
        const pending = this.readPendingList(deletionKey);
        const remaining: { id: string; deletedAt: number }[] = [];
        const justDeletedIds = new Set<string>();
        for (const entry of pending) {
            let tombstoneWritten = false;
            try {
                await backend.writeTombstone(resource, entry.id, entry.deletedAt);
                tombstoneWritten = true;
                // Add to justDeletedIds *immediately* after the tombstone is
                // up. If `remove` fails below (transient network blip etc.),
                // the live object is still on cloud — but the tombstone is
                // the authoritative "this is deleted" signal, so this
                // device's main loop must NOT re-download. Other devices
                // will pick up the tombstone on their next sync; the next
                // retry on this device cleans up the live object.
                justDeletedIds.add(entry.id);
            } catch (e) {
                console.error(`[SyncService] Failed to write tombstone for ${resource} ${entry.id}, will retry`, e);
                report.errors.push({ resource, id: entry.id, op: 'delete', message: errMsg(e) });
            }

            let removeOk = true;
            if (tombstoneWritten && remoteById.has(entry.id)) {
                try {
                    await backend.remove(resource, entry.id);
                    remoteById.delete(entry.id);
                    report.deleted++;
                } catch (e) {
                    console.error(`[SyncService] Failed to remove remote ${resource} ${entry.id}, will retry`, e);
                    report.errors.push({ resource, id: entry.id, op: 'delete', message: errMsg(e) });
                    removeOk = false;
                }
            }

            if (!tombstoneWritten || !removeOk) {
                remaining.push(entry);
            }
        }
        localStorage.setItem(deletionKey, JSON.stringify(remaining));

        // Apply remote tombstones. For each tombstone, compute the newest
        // surviving timestamp on either side — if NEITHER side beat the
        // tombstone, both sides are pre-delete and need to go (deleting only
        // local would leave the cloud copy to resurrect on the next sync).
        // If either side is newer, that's a post-delete restore/edit — keep
        // it, let the regular newer-wins loop pick the winner.
        try {
            const tombstones = await backend.listTombstones(resource);
            for (const tomb of tombstones) {
                if (justDeletedIds.has(tomb.id)) continue;
                const local = localById.get(tomb.id);
                const remote = remoteById.get(tomb.id);
                if (!local && !remote) continue;
                const localTime = local ? this.localTimestamp(local, resource) : -Infinity;
                const remoteTime = remote ? remote.lastActiveAt : -Infinity;
                if (localTime > tomb.deletedAt || remoteTime > tomb.deletedAt) continue;
                try {
                    if (local) {
                        if (resource === 'book') {
                            await this.storage.deleteBook(tomb.id);
                            deletedBookIds.add(tomb.id);
                        } else {
                            await this.storage.deleteCollection(tomb.id);
                        }
                        localById.delete(tomb.id);
                        report.deleted++;
                    }
                    if (remote) {
                        await backend.remove(resource, tomb.id);
                        remoteById.delete(tomb.id);
                        report.deleted++;
                    }
                    justDeletedIds.add(tomb.id);
                    console.log(`[Sync ${resource} ${tomb.id.slice(0, 8)}] tombstone wins → delete (local=${localTime}, remote=${remoteTime}, deletedAt=${tomb.deletedAt})`);
                } catch (e) {
                    console.error(`[SyncService] Failed to apply tombstone for ${resource} ${tomb.id}`, e);
                    report.errors.push({ resource, id: tomb.id, op: 'delete', message: errMsg(e) });
                }
            }
        } catch (e) {
            console.error(`[SyncService] Failed to list tombstones for ${resource}`, e);
            report.errors.push({ resource, id: '', op: 'list', message: errMsg(e) });
        }

        // Refresh localList in case tombstones removed entries.
        localList = Array.from(localById.values());

        // Single newer-wins loop over the union of local + remote ids.
        const allIds = new Set<string>([
            ...localList.map(l => l.id),
            ...remoteById.keys()
        ]);

        for (const id of allIds) {
            // SeaweedFS GET-after-DELETE consistency guard: don't try to read
            // an object we just removed within the same sync run, even if
            // it's still in the cached remoteList array. Also skips entities
            // we just locally-deleted via tombstone application.
            if (justDeletedIds.has(id)) continue;

            const local = localById.get(id);
            const remote = remoteById.get(id);

            if (local && !remote) {
                console.log(`[Sync ${resource} ${id.slice(0, 8)}] local-only → upload (local=${this.localTimestamp(local, resource)})`);
                await this.uploadEntity(backend, resource, local, report);
                continue;
            }
            if (!local && remote) {
                console.log(`[Sync ${resource} ${id.slice(0, 8)}] remote-only → download (remote=${remote.lastActiveAt})`);
                await this.downloadEntity(backend, resource, remote.id, remote.lastActiveAt, report, downloadedBookIds);
                continue;
            }
            if (local && remote) {
                const localTime = this.localTimestamp(local, resource);
                const remoteTime = remote.lastActiveAt;
                if (localTime > remoteTime) {
                    console.log(`[Sync ${resource} ${id.slice(0, 8)}] local newer → upload (local=${localTime}, remote=${remoteTime}, Δ=${localTime - remoteTime}ms)`);
                    await this.uploadEntity(backend, resource, local, report);
                } else if (remoteTime > localTime) {
                    console.log(`[Sync ${resource} ${id.slice(0, 8)}] remote newer → download (local=${localTime}, remote=${remoteTime}, Δ=${remoteTime - localTime}ms)`);
                    await this.downloadEntity(backend, resource, remote.id, remoteTime, report, downloadedBookIds);
                } else {
                    // equal → synced, no log to keep console clean
                }
            }
        }

        return report;
    }

    private async uploadEntity(
        backend: SyncBackend,
        resource: SyncResource,
        local: Book | Collection,
        report: SyncReport
    ): Promise<void> {
        try {
            const cleaned = resource === 'book'
                ? cleanBookForSync(local)
                : cleanCollectionForSync(local);
            const lastActiveAt = this.localTimestamp(cleaned, resource);
            await backend.write(resource, local.id, JSON.stringify(cleaned), lastActiveAt);
            report.uploaded++;
        } catch (e) {
            console.error(`[SyncService] Failed to upload ${resource} ${local.id}`, e);
            report.errors.push({ resource, id: local.id, op: 'upload', message: errMsg(e) });
        }
    }

    private async downloadEntity(
        backend: SyncBackend,
        resource: SyncResource,
        id: string,
        expectedRemoteLastActive: number,
        report: SyncReport,
        downloadedBookIds: Set<string>
    ): Promise<void> {
        try {
            const json = await backend.read(resource, id);
            await this.applyRemote(resource, json);
            report.downloaded++;
            if (resource === 'book') downloadedBookIds.add(id);

            // Self-heal: if the body's lastActiveAt differs from what list()
            // reported via metadata, the cloud's `last_active` metadata is
            // missing or stale (e.g., legacy upload from before the metadata
            // scheme). Re-upload with correct metadata so future syncs see a
            // matching remote/local time and stop looping in download.
            const stored = resource === 'book'
                ? await this.storage.getBook(id)
                : await this.storage.getCollection(id);
            if (stored) {
                const bodyTime = this.localTimestamp(stored, resource);
                // 1000ms slack so a backend that truncates metadata to
                // second precision (or rounds in any sub-second way) doesn't
                // trigger a redundant re-upload every session. Legacy uploads
                // missing metadata fall back to either body extraction (where
                // bodyTime matches) or modifiedAt (where the gap is typically
                // minutes), both well outside this window.
                const drift = Math.abs(bodyTime - expectedRemoteLastActive);
                if (drift > 1000) {
                    const healKey = `${resource}:${id}`;
                    if (this.selfHealedIds.has(healKey)) {
                        console.warn(`[Sync ${resource} ${id.slice(0, 8)}] self-heal already attempted this session, skipping (body=${bodyTime}, expected=${expectedRemoteLastActive}); backend may be mutating metadata`);
                    } else {
                        this.selfHealedIds.add(healKey);
                        console.warn(`[Sync ${resource} ${id.slice(0, 8)}] self-heal: body=${bodyTime} ≠ expected=${expectedRemoteLastActive} (Δ=${bodyTime - expectedRemoteLastActive}ms) → re-upload`);
                        await this.uploadEntity(backend, resource, stored, report);
                    }
                }
            }
        } catch (e) {
            console.error(`[SyncService] Failed to download ${resource} ${id}`, e);
            report.errors.push({ resource, id, op: 'download', message: errMsg(e) });
        }
    }

    private localTimestamp(item: Book | Collection, resource: SyncResource): number {
        // Fallback to 0 for legacy IDB rows missing the timestamp field —
        // `undefined > N` returns false in both directions, so without this
        // a legacy entry would stall forever (never recognized as older or
        // newer than its remote counterpart).
        const ts = resource === 'book'
            ? (item as Book).lastActiveAt
            : (item as Collection).updatedAt;
        return ts || 0;
    }

    private async applyRemote(resource: SyncResource, json: string): Promise<void> {
        if (resource === 'book') {
            const book = cleanBookForSync(JSON.parse(json));
            if (!book.collectionId) book.collectionId = ROOT_COLLECTION_ID;
            await this.storage.saveBook(book);
        } else {
            const collection = cleanCollectionForSync(JSON.parse(json));
            await this.storage.saveCollection(collection);
        }
    }

    /**
     * Force push: this device is the source of truth. List cloud, delete
     * anything not local, then unconditionally upload every local entity.
     * Bypasses the newer-wins decision tree.
     *
     * @param opts.skipSnapshot If false (default), build a `forcePush`
     * snapshot of the *cloud* before overwriting it. If snapshotting fails
     * the throw is wrapped as `SnapshotPreOpError` so the UI can prompt
     * "snapshot failed — continue anyway?". Pass `true` to skip after that
     * confirmation.
     */
    async forcePushAll(opts: { skipSnapshot?: boolean } = {}): Promise<ForcePushReport> {
        return this.runExclusive('forcePush', async () => {
            if (!opts.skipSnapshot) {
                await this.createPreOpSnapshotOrThrow('forcePush', 'cloud');
            }
            const report = await this.doForcePushAll();
            this.runRetentionInBackground();
            return report;
        });
    }

    private async doForcePushAll(): Promise<ForcePushReport> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();
        const report: ForcePushReport = { uploaded: 0, deletedRemote: 0, errors: [] };

        for (const resource of ['collection', 'book'] as const) {
            const localList: (Book | Collection)[] = resource === 'book'
                ? await this.storage.getBooks()
                : await this.storage.getCollections();
            const localIds = new Set(localList.map(l => l.id));
            const remoteList = await backend.list(resource);
            const now = Date.now();

            // Wipe pre-existing tombstones first — local is the source of
            // truth, so any "this was deleted" record from another device
            // shouldn't keep haunting our entities. Then write fresh
            // tombstones below for entities we're deleting from the cloud
            // so other devices receive the message.
            try {
                await backend.clearTombstones(resource);
            } catch (e) {
                console.error(`[SyncService] forcePush: failed to clear tombstones for ${resource}`, e);
                report.errors.push({ resource, id: '', op: 'delete', message: errMsg(e) });
            }

            for (const remote of remoteList) {
                if (localIds.has(remote.id)) continue;
                try {
                    await backend.remove(resource, remote.id);
                    // Tombstone so other devices learn this id was removed
                    // and don't resurrect it via local-only upload.
                    await backend.writeTombstone(resource, remote.id, now);
                    report.deletedRemote++;
                } catch (e) {
                    console.error(`[SyncService] forcePush: failed to delete remote ${resource} ${remote.id}`, e);
                    report.errors.push({ resource, id: remote.id, op: 'delete', message: errMsg(e) });
                }
            }

            for (const local of localList) {
                try {
                    const cleaned = resource === 'book'
                        ? cleanBookForSync(local)
                        : cleanCollectionForSync(local);
                    const lastActiveAt = this.localTimestamp(cleaned, resource);
                    await backend.write(resource, local.id, JSON.stringify(cleaned), lastActiveAt);
                    report.uploaded++;
                } catch (e) {
                    console.error(`[SyncService] forcePush: failed to upload ${resource} ${local.id}`, e);
                    report.errors.push({ resource, id: local.id, op: 'upload', message: errMsg(e) });
                }
            }
        }

        // Pending deletions are now redundant — anything we wanted gone is gone.
        for (const r of ['collection', 'book'] as const) {
            localStorage.setItem(PENDING_DELETIONS_KEY[r], JSON.stringify([]));
        }

        this.lastSyncAt = Date.now();
        return report;
    }

    /**
     * Force pull: cloud is the source of truth. List cloud, delete every
     * local entity not on cloud, then unconditionally download every cloud
     * entity. Reloads the active session if its book id either disappeared
     * or was overwritten.
     *
     * @param opts.skipSnapshot If false (default), build a `forcePull`
     * snapshot of the *local* IDB before overwriting it. Snapshot failure
     * raises `SnapshotPreOpError`.
     */
    async forcePullAll(opts: { skipSnapshot?: boolean } = {}): Promise<ForcePullReport> {
        return this.runExclusive('forcePull', async () => {
            if (!opts.skipSnapshot) {
                await this.createPreOpSnapshotOrThrow('forcePull', 'local');
            }
            const report = await this.doForcePullAll();
            this.runRetentionInBackground();
            return report;
        });
    }

    private async doForcePullAll(): Promise<ForcePullReport> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();
        const report: ForcePullReport = { downloaded: 0, deletedLocal: 0, errors: [] };

        const activeBookId = this.session.currentBookId();
        let activeBookGone = false;
        let activeBookOverwritten = false;

        for (const resource of ['collection', 'book'] as const) {
            const remoteList = await backend.list(resource);
            const remoteIds = new Set(remoteList.map(r => r.id));
            const localList: (Book | Collection)[] = resource === 'book'
                ? await this.storage.getBooks()
                : await this.storage.getCollections();

            // Wipe local entries not on cloud (root collection is special — keep
            // it; it's rebuilt by ensureRoot if missing on cloud).
            for (const local of localList) {
                if (remoteIds.has(local.id)) continue;
                if (resource === 'collection' && local.id === ROOT_COLLECTION_ID) continue;
                try {
                    if (resource === 'book') {
                        if (local.id === activeBookId) activeBookGone = true;
                        await this.storage.deleteBook(local.id);
                    } else {
                        await this.storage.deleteCollection(local.id);
                    }
                    report.deletedLocal++;
                } catch (e) {
                    console.error(`[SyncService] forcePull: failed to delete local ${resource} ${local.id}`, e);
                    report.errors.push({ resource, id: local.id, op: 'delete', message: errMsg(e) });
                }
            }

            // Overwrite local with cloud body for everything cloud has.
            for (const remote of remoteList) {
                try {
                    const json = await backend.read(resource, remote.id);
                    await this.applyRemote(resource, json);
                    if (resource === 'book' && remote.id === activeBookId) activeBookOverwritten = true;
                    report.downloaded++;
                } catch (e) {
                    console.error(`[SyncService] forcePull: failed to download ${resource} ${remote.id}`, e);
                    report.errors.push({ resource, id: remote.id, op: 'download', message: errMsg(e) });
                }
            }
        }

        // Pending deletions are obsolete after a force pull.
        for (const r of ['collection', 'book'] as const) {
            localStorage.setItem(PENDING_DELETIONS_KEY[r], JSON.stringify([]));
        }

        await this.collections.load();

        // Reload active session if needed.
        if (activeBookGone) {
            const remaining = await this.storage.getBooks();
            if (remaining.length > 0) {
                const sorted = [...remaining].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
                await this.session.loadBook(sorted[0].id, false);
            } else {
                // No books left — must clear the in-memory session signals
                // (messages, files, stats) or the UI keeps showing data for
                // the book IDB no longer has. `false` skips the auto-save
                // that would otherwise re-create the deleted book.
                await this.session.unloadCurrentSession(false);
            }
        } else if (activeBookOverwritten && activeBookId) {
            await this.session.loadBook(activeBookId, false);
        }

        this.lastSyncAt = Date.now();
        return report;
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

    /**
     * Snapshot all user-modified built-in prompts + every user profile, and
     * PUT to cloud as the v2 schema:
     *   { version: 2, profiles: [...], prompts: { "<id>:<type>": { content, tokens? } } }
     *
     * Built-in defaults still stay out (only user-customized rows ship). User
     * profiles ship in full, including unmodified rows, since the receiving
     * device has no shipped asset to fall back on.
     */
    async uploadPrompts(): Promise<{ exported: number }> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();

        const prompts: Record<string, { content: string; tokens?: number }> = {};
        const profilesOut: PromptsV2['profiles'] = [];
        let exported = 0;

        for (const profile of this.profileRegistry.list()) {
            if (profile.isBuiltIn) {
                for (const type of PROMPT_TYPES) {
                    const flagKey = `prompt_user_modified_${type}`;
                    const scopedFlagKey = profile.id === 'cloud' ? flagKey : `${profile.id}:${flagKey}`;
                    if (localStorage.getItem(scopedFlagKey) !== 'true') continue;
                    const rec = await this.storage.getProfilePrompt(type, profile.id);
                    if (!rec) continue;
                    prompts[`${profile.id}:${type}`] = { content: rec.content, tokens: rec.tokens };
                    exported++;
                }
            } else {
                profilesOut.push({
                    id: profile.id,
                    displayName: profile.displayName ?? profile.id,
                    baseProfileId: profile.baseProfileId ?? 'cloud',
                    createdAt: profile.createdAt ?? Date.now(),
                    updatedAt: profile.updatedAt ?? Date.now()
                });
                for (const type of PROMPT_TYPES) {
                    const rec = await this.storage.getProfilePrompt(type, profile.id);
                    if (!rec) continue;
                    prompts[`${profile.id}:${type}`] = { content: rec.content, tokens: rec.tokens };
                    exported++;
                }
            }
        }

        const payload: PromptsV2 = { version: 2, profiles: profilesOut, prompts };
        await backend.writePrompts(JSON.stringify(payload));
        return { exported };
    }

    /**
     * Pulls prompts.json. Recognizes:
     *  - v2: { version: 2, profiles, prompts } — upserts profile meta then
     *    writes prompt rows. If an incoming user profile id collides with an
     *    existing local one whose displayName differs, the import is renamed
     *    to `${id}_imported_${shortHash}` so neither side loses data.
     *  - v1 (no `version`): legacy flat map. Only built-in rows are imported;
     *    any user-prefixed entry is silently skipped (treated as orphan since
     *    v1 had no metadata).
     */
    async downloadPrompts(): Promise<{ imported: number }> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();
        const json = await backend.readPrompts();
        if (!json) return { imported: 0 };

        const parsed = JSON.parse(json) as Partial<PromptsV2> | Record<string, { content: string; tokens?: number }>;
        if (isPromptsV2(parsed)) {
            return this.applyPromptsV2(parsed);
        }
        return this.applyPromptsV1Legacy(parsed as Record<string, { content: string; tokens?: number }>);
    }

    private async applyPromptsV2(payload: PromptsV2): Promise<{ imported: number }> {
        // First pass: upsert user profiles from `profiles[]`. Any id collision
        // against a different local profile is resolved by remapping the
        // incoming id throughout this import. Built-in ids are reserved and
        // never appear in `profiles[]`; an incoming id that matches a built-in
        // is also remapped (treat as a name collision with a reserved id).
        const idRemap = new Map<string, string>();
        for (const incoming of payload.profiles ?? []) {
            // Skip rows with garbage ids — empty / whitespace / illegal chars
            // would otherwise become valid IDB keys and registry entries.
            if (!isValidUserProfileId(incoming.id)) {
                console.warn('[SyncService] applyPromptsV2: dropping profile with invalid id', incoming);
                continue;
            }

            const existing = this.profileRegistry.get(incoming.id);
            const collidesWithBuiltIn = existing?.isBuiltIn === true;
            const collidesDifferent = existing && !existing.isBuiltIn &&
                (existing.displayName !== incoming.displayName || existing.baseProfileId !== incoming.baseProfileId);

            const targetId = (collidesWithBuiltIn || collidesDifferent)
                ? `${incoming.id}_imported_${importSuffix()}`
                : incoming.id;
            if (targetId !== incoming.id) idRemap.set(incoming.id, targetId);

            const meta = {
                id: targetId,
                displayName: incoming.displayName,
                baseProfileId: incoming.baseProfileId,
                createdAt: incoming.createdAt,
                updatedAt: incoming.updatedAt
            };
            await this.storage.putProfileMeta(meta);
            const existingTarget = this.profileRegistry.get(targetId);
            if (existingTarget) {
                this.profileRegistry.update(targetId, { displayName: incoming.displayName, baseProfileId: incoming.baseProfileId, updatedAt: incoming.updatedAt });
            } else {
                this.profileRegistry.add({
                    id: targetId,
                    isBuiltIn: false,
                    subDir: null,
                    displayName: incoming.displayName,
                    baseProfileId: incoming.baseProfileId,
                    createdAt: incoming.createdAt,
                    updatedAt: incoming.updatedAt
                });
            }
        }

        // Second pass: prompt rows.
        let imported = 0;
        for (const [key, value] of Object.entries(payload.prompts ?? {})) {
            if (!value || typeof value.content !== 'string') continue;
            const colon = key.indexOf(':');
            if (colon <= 0) continue;
            const incomingId = key.slice(0, colon);
            const type = key.slice(colon + 1);
            if (!PROMPT_TYPES.includes(type as PromptType)) continue;

            const profileId = idRemap.get(incomingId) ?? incomingId;
            const profile = this.profileRegistry.get(profileId);
            const isBuiltIn = BUILT_IN_PROFILES.some(p => p.id === profileId);
            // Reject orphan user-id rows without a matching profile entry.
            if (!isBuiltIn && !profile) continue;

            await this.storage.saveProfilePrompt(type, profileId, value.content, value.tokens);
            if (isBuiltIn) {
                const flagKey = `prompt_user_modified_${type}`;
                const scopedFlagKey = profileId === 'cloud' ? flagKey : `${profileId}:${flagKey}`;
                localStorage.setItem(scopedFlagKey, 'true');
            }
            imported++;
        }
        return { imported };
    }

    /**
     * Legacy flat-map import. Pre-v2 payloads only ever held built-in rows
     * (the user-profile feature didn't exist), so user-prefixed entries are
     * dropped on import. Built-in rows are written exactly like v2.
     */
    private async applyPromptsV1Legacy(parsed: Record<string, { content: string; tokens?: number }>): Promise<{ imported: number }> {
        let imported = 0;
        for (const [key, value] of Object.entries(parsed)) {
            if (!value || typeof value.content !== 'string') continue;
            const colon = key.indexOf(':');
            if (colon <= 0) continue;
            const profileId = key.slice(0, colon);
            const type = key.slice(colon + 1);
            if (!BUILT_IN_PROFILES.some(p => p.id === profileId)) continue;
            if (!PROMPT_TYPES.includes(type as PromptType)) continue;
            await this.storage.saveProfilePrompt(type, profileId, value.content, value.tokens);
            const flagKey = `prompt_user_modified_${type}`;
            const scopedFlagKey = profileId === 'cloud' ? flagKey : `${profileId}:${flagKey}`;
            localStorage.setItem(scopedFlagKey, 'true');
            imported++;
        }
        return { imported };
    }

    /**
     * Export a single profile (built-in or user) into a portable JSON blob
     * shaped like the v2 schema with one entry. The receiving end can pass
     * it back through `importSingleProfile` (or `applyPromptsV2`).
     */
    async exportSingleProfile(profileId: string): Promise<string> {
        const profile = this.profileRegistry.get(profileId);
        if (!profile) throw new Error(`Unknown profile: ${profileId}`);

        const prompts: Record<string, { content: string; tokens?: number }> = {};
        for (const type of PROMPT_TYPES) {
            const rec = await this.storage.getProfilePrompt(type, profileId);
            if (!rec) continue;
            prompts[`${profileId}:${type}`] = { content: rec.content, tokens: rec.tokens };
        }

        const profilesOut: PromptsV2['profiles'] = profile.isBuiltIn ? [] : [{
            id: profile.id,
            displayName: profile.displayName ?? profile.id,
            baseProfileId: profile.baseProfileId ?? 'cloud',
            createdAt: profile.createdAt ?? Date.now(),
            updatedAt: profile.updatedAt ?? Date.now()
        }];

        const payload: PromptsV2 = { version: 2, profiles: profilesOut, prompts };
        return JSON.stringify(payload, null, 2);
    }

    /**
     * Import a single-profile JSON blob produced by `exportSingleProfile`.
     * Same conflict-rename behaviour as `applyPromptsV2`.
     */
    async importSingleProfile(json: string): Promise<{ imported: number }> {
        const parsed = JSON.parse(json) as unknown;
        if (!isPromptsV2(parsed)) throw new Error('Not a v2 prompt profile export');
        return this.applyPromptsV2(parsed);
    }

    // ===== Snapshots ======================================================

    /**
     * Stable per-installation device id, surfaced into snapshot manifests so
     * the UI can label "this device" vs another. Generated lazily on first
     * use and persisted to localStorage; clearing storage rotates the id,
     * which is fine — older manifests just show the previous value verbatim.
     */
    getDeviceId(): string {
        let id = localStorage.getItem(LS_DEVICE_ID);
        if (!id) {
            id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
                ? crypto.randomUUID()
                : 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem(LS_DEVICE_ID, id);
        }
        return id;
    }

    /**
     * `<ISO>-<4hex>` where the ISO has `:` and `.` swapped to `-` so the id
     * is path-safe on both S3 keys and Drive folder names. The 4-char hex
     * tail is collision protection at the same millisecond (~1/65536).
     * Backends only validate shape via assertSnapshotId; the format chosen
     * here is also lex-sortable, which keeps listSnapshots ordering cheap.
     */
    generateSnapshotId(): string {
        const iso = new Date().toISOString().replace(/[:.]/g, '-');
        const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
        return `${iso}-${rand}`;
    }

    private buildSnapshotMeta(trigger: SnapshotTrigger, note?: string): SnapshotMetaInput {
        return {
            createdAt: Date.now(),
            trigger,
            note,
            deviceId: this.getDeviceId()
        };
    }

    /**
     * Reads local IDB books / collections (cleaned for sync) and pending
     * deletions, packaged for `createSnapshotFromLocal`. Used by force pull
     * (rescue local before cloud overwrites it).
     */
    private async collectLocalSnapshotPayload(): Promise<SnapshotLocalPayload> {
        const [books, collections] = await Promise.all([
            this.storage.getBooks(),
            this.storage.getCollections()
        ]);
        const bookEntries = books.map(b => {
            const cleaned = cleanBookForSync(b);
            return {
                id: b.id,
                lastActiveAt: this.localTimestamp(cleaned, 'book'),
                json: JSON.stringify(cleaned)
            };
        });
        const collectionEntries = collections.map(c => {
            const cleaned = cleanCollectionForSync(c);
            return {
                id: c.id,
                lastActiveAt: this.localTimestamp(cleaned, 'collection'),
                json: JSON.stringify(cleaned)
            };
        });
        const tombstones: SnapshotLocalPayload['tombstones'] = [];
        for (const r of ['book', 'collection'] as const) {
            const pending = this.readPendingList(PENDING_DELETIONS_KEY[r]);
            for (const e of pending) {
                tombstones.push({ resource: r, id: e.id, deletedAt: e.deletedAt });
            }
        }
        return { books: bookEntries, collections: collectionEntries, tombstones };
    }

    private async createPreOpSnapshotOrThrow(
        trigger: 'forcePush' | 'forcePull' | 'preRestore',
        source: 'cloud' | 'local'
    ): Promise<SnapshotManifest> {
        try {
            const backend = await this.getActiveBackend();
            await backend.authenticate();
            const id = this.generateSnapshotId();
            const meta = this.buildSnapshotMeta(trigger);
            if (source === 'cloud') {
                return await backend.createSnapshotFromCloud(id, meta);
            }
            const payload = await this.collectLocalSnapshotPayload();
            return await backend.createSnapshotFromLocal(id, meta, payload);
        } catch (e) {
            throw new SnapshotPreOpError(trigger, errMsg(e));
        }
    }

    /**
     * Manual snapshot: captures cloud (the shared state). If local has
     * unsynced changes the caller should sync first — surfaced in the UI
     * confirm dialog, not enforced here.
     *
     * Deliberately does NOT run inside `runExclusive`: a queued auto-sync
     * could otherwise wait minutes behind a slow CopyObject sweep and time
     * out the user. The cost is that an in-flight upload can race the
     * server-side copy, producing a snapshot whose objects are a mix of
     * pre- and post-upload state. Acceptable here because manual is a
     * convenience capture, not the rescue point for a destructive op
     * (those go through createPreOpSnapshotOrThrow under the relevant lock).
     */
    async manualSnapshot(note?: string): Promise<SnapshotManifest> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();
        const id = this.generateSnapshotId();
        const manifest = await backend.createSnapshotFromCloud(id, this.buildSnapshotMeta('manual', note));
        this.runRetentionInBackground();
        return manifest;
    }

    async listSnapshots(): Promise<SnapshotMeta[]> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();
        return backend.listSnapshots();
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();
        await backend.deleteSnapshot(snapshotId);
    }

    async updateSnapshotNote(snapshotId: string, note: string): Promise<void> {
        const backend = await this.getActiveBackend();
        await backend.authenticate();
        await backend.updateSnapshotNote(snapshotId, note);
    }

    /**
     * Restore live cloud state from a snapshot, then resync local IDB to
     * match. Quiesces auto-sync for the duration; *other devices* are not
     * blocked, so the UI must warn the user to pause auto-sync there.
     *
     * @param opts.skipPreRestoreSnapshot Skip the pre-restore safety
     * snapshot. Default false; pass true after the user confirmed via UI
     * dialog that the safety snapshot already failed and they still want to
     * proceed.
     */
    async restoreSnapshot(
        snapshotId: string,
        opts: { skipPreRestoreSnapshot?: boolean } = {}
    ): Promise<void> {
        return this.runExclusive('restore', async () => {
            this.cancelDebounce();
            this.restoreInProgress = true;
            try {
                if (!opts.skipPreRestoreSnapshot) {
                    await this.createPreOpSnapshotOrThrow('preRestore', 'cloud');
                }

                const backend = await this.getActiveBackend();
                await backend.authenticate();

                await backend.restoreSnapshot(snapshotId);

                // Pull cloud (which now reflects the snapshot) down to local.
                // Pending deletions are stale — restore wrote tombstones at
                // Date.now() on cloud, and any local pending delete predates
                // that timestamp, so they'd no-op anyway. Wipe to keep state
                // tidy.
                for (const r of ['collection', 'book'] as const) {
                    localStorage.setItem(PENDING_DELETIONS_KEY[r], JSON.stringify([]));
                }

                const report = await this.doForcePullAll();
                this.runRetentionInBackground();

                // doForcePullAll already handled active-book reload via its
                // activeBookGone / activeBookOverwritten branches. Nothing
                // extra to do here, but warn if it logged errors.
                if (report.errors.length > 0) {
                    console.warn('[SyncService] restoreSnapshot: forcePull surfaced errors', report.errors);
                }
            } finally {
                this.restoreInProgress = false;
                this.failureCount = 0;
            }
        });
    }

    /**
     * Runs in the background (fire-and-forget) after every snapshot create.
     * Auto-trigger snapshots beyond `SNAPSHOT_AUTO_RETENTION` are deleted
     * oldest-first. Manual snapshots are excluded — the user explicitly
     * pressed a button on those, retention shouldn't surprise-delete them.
     */
    private runRetentionInBackground(): void {
        void this.runRetention().catch(e => {
            console.warn('[SyncService] Retention sweep failed (non-fatal)', e);
        });
    }

    private async runRetention(): Promise<void> {
        const backend = await this.getActiveBackend();
        const all = await backend.listSnapshots();
        const auto = all.filter(s => s.trigger !== 'manual')
            .sort((a, b) => b.createdAt - a.createdAt);
        const excess = auto.slice(SNAPSHOT_AUTO_RETENTION);
        if (excess.length === 0) return;
        let cursor = 0;
        const runners = Array.from(
            { length: Math.min(RETENTION_DELETE_CONCURRENCY, excess.length) },
            async () => {
                while (cursor < excess.length) {
                    const i = cursor++;
                    try {
                        await backend.deleteSnapshot(excess[i].id);
                    } catch (e) {
                        console.warn(`[SyncService] Retention: failed to delete ${excess[i].id}`, e);
                    }
                }
            }
        );
        await Promise.all(runners);
    }

    private loadBackendId(): SyncBackendId {
        const v = localStorage.getItem(LS_BACKEND);
        if (v === 's3') return 's3';
        if (v === 'file') return 'file';
        return 'gdrive';
    }

    private loadAutoFlags(): Record<SyncBackendId, boolean> {
        return {
            gdrive: localStorage.getItem(LS_AUTO_PREFIX + 'gdrive') === '1',
            s3: localStorage.getItem(LS_AUTO_PREFIX + 's3') === '1',
            // file backend deliberately does not support auto-sync — see plan/file-sync-backend.md §四
            file: false
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
