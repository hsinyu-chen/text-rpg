import { Injectable, inject, signal } from '@angular/core';
import { StorageService } from '../storage.service';
import { SessionService } from '../session.service';
import { CollectionService } from '../collection.service';
import { GameStateService } from '../game-state.service';
import { Book, Collection, ROOT_COLLECTION_ID } from '@app/core/models/types';
import {
    SyncBackend, SyncBackendId, SyncResource, SnapshotLocalPayload
} from './sync.types';
import { cleanBookForSync, cleanCollectionForSync } from './clean.util';
import { errMsg } from './error.util';
import { PromptCloudSyncService } from './prompt-cloud-sync.service';
import { SnapshotService } from './snapshot.service';
import { PendingDeletion, SyncTombstoneTracker } from './tombstone-tracker.service';
import { SyncBackendResolver } from './sync-backend-resolver.service';
import { AutoSyncScheduler } from './auto-sync-scheduler.service';

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

@Injectable({ providedIn: 'root' })
export class SyncService {
    private storage = inject(StorageService);
    private session = inject(SessionService);
    private collections = inject(CollectionService);
    private state = inject(GameStateService);
    private readonly promptCloudSync = inject(PromptCloudSyncService);
    private readonly snapshot = inject(SnapshotService);
    private readonly tombstones = inject(SyncTombstoneTracker);
    private readonly backends = inject(SyncBackendResolver);
    private readonly scheduler = inject(AutoSyncScheduler);

    /**
     * Set when a non-boot sync downloaded a newer version of the active book.
     * The toast prompts the user to load it; we don't silently swap because
     * the user might be mid-typing.
     */
    remoteUpdateAvailable = signal<RemoteUpdateAvailable | null>(null);

    private inFlight: { kind: 'sync' | 'forcePush' | 'forcePull' | 'restore'; promise: Promise<unknown> } | null = null;
    /**
     * Set true while restoreSnapshot is rewriting state. Auto-sync would
     * race with the restore (its in-flight reads / writes get mixed in,
     * potentially propagating mid-restore garbage to other devices), so we
     * gate scheduling on this flag and refuse to schedule new runs until
     * restore is done.
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
    private isInitialSync = false;

    constructor() {
        // PromptCloudSyncService and SnapshotService both stay out of the
        // SyncService DI graph so they don't form a circular dep — wire the
        // backend resolvers here.
        this.promptCloudSync.registerBackendResolver(() => this.backends.getActiveBackend());
        this.snapshot.registerBackendResolver(() => this.backends.getActiveBackend());

        // Auto-sync scheduling lives in AutoSyncScheduler. It owns the
        // visibility-change listener and the debounce pipeline; we hand
        // it our `syncAll` runner + a `restoreInProgress` precondition
        // probe (the scheduler is providedIn: 'root' too, so injecting
        // SyncService back into it would form a circular dep).
        this.scheduler.register(
            () => this.queueSync(),
            () => !this.restoreInProgress && this.state.status() !== 'generating'
        );
    }

    /**
     * Thin wrappers over `SyncBackendResolver` that also notify the
     * scheduler so it can reset its circuit breaker / cancel a pending
     * debounce. Kept as wrappers so UI callers continue to go through
     * SyncService (single public surface for sync ops).
     */
    setActiveBackend(id: SyncBackendId): void {
        this.backends.setActiveBackend(id);
        this.scheduler.onBackendChanged();
    }

    setAutoSyncEnabled(id: SyncBackendId, on: boolean): void {
        this.backends.setAutoSyncEnabled(id, on);
        this.scheduler.onAutoToggle();
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
     * versions are silently reloaded into the active session.
     */
    async bootSync(): Promise<void> {
        this.dropLegacyBaselines();
        if (!this.scheduler.isActive()) return;
        this.isInitialSync = true;
        try {
            await this.syncAll();
            // syncAll already calls scheduler.notifySyncCompleted on
            // success, which resets the circuit breaker — no explicit
            // recordRun(true) needed here.
        } catch (e) {
            this.scheduler.recordRun(false);
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

    /**
     * Scheduler-only entry point: never coalesces with an in-flight
     * sync. The scheduler's `concatMap` relies on a happen-after
     * guarantee — if a save fires schedule() during a manual sync,
     * the auto-sync trigger that follows MUST run a fresh sync to
     * include that save. Plain `syncAll()` would return the manual
     * sync's promise and the save would be silently dropped.
     */
    queueSync(): Promise<SyncReport> {
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
        const backend = await this.backends.getActiveBackend();
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

        this.scheduler.notifySyncCompleted();
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
        const pending = this.tombstones.read(resource);
        const remaining: PendingDeletion[] = [];
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
        this.tombstones.write(resource, remaining);

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
                await this.snapshot.createPreOpSnapshot('forcePush', 'cloud');
            }
            const report = await this.doForcePushAll();
            this.snapshot.runRetentionInBackground();
            return report;
        });
    }

    private async doForcePushAll(): Promise<ForcePushReport> {
        const backend = await this.backends.getActiveBackend();
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
        this.tombstones.clearAll();

        this.scheduler.notifySyncCompleted();
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
                await this.snapshot.createPreOpSnapshot('forcePull', 'local', () => this.collectLocalSnapshotPayload());
            }
            const report = await this.doForcePullAll();
            this.snapshot.runRetentionInBackground();
            return report;
        });
    }

    private async doForcePullAll(): Promise<ForcePullReport> {
        const backend = await this.backends.getActiveBackend();
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
        this.tombstones.clearAll();

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

        this.scheduler.notifySyncCompleted();
        return report;
    }

    /**
     * Pushes a settings JSON snapshot to the active backend.
     */
    async uploadSettings(content: string): Promise<void> {
        const backend = await this.backends.getActiveBackend();
        await backend.authenticate();
        await backend.writeSettings(content);
    }

    /**
     * Pulls the settings JSON snapshot from the active backend, or null if none.
     */
    async downloadSettings(): Promise<string | null> {
        const backend = await this.backends.getActiveBackend();
        await backend.authenticate();
        return backend.readSettings();
    }

    // ===== Snapshots ======================================================

    /**
     * Reads local IDB books / collections (cleaned for sync) and pending
     * deletions, packaged for `createSnapshotFromLocal`. Stays here because
     * it depends on sync internals (`localTimestamp` + tombstone tracker)
     * that have no business escaping into `SnapshotService`.
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
        return {
            books: bookEntries,
            collections: collectionEntries,
            tombstones: this.tombstones.readAll()
        };
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
            this.scheduler.cancel();
            this.restoreInProgress = true;
            try {
                if (!opts.skipPreRestoreSnapshot) {
                    await this.snapshot.createPreOpSnapshot('preRestore', 'cloud');
                }

                const backend = await this.backends.getActiveBackend();
                await backend.authenticate();

                await backend.restoreSnapshot(snapshotId);

                // Pull cloud (which now reflects the snapshot) down to local.
                // Pending deletions are stale — restore wrote tombstones at
                // Date.now() on cloud, and any local pending delete predates
                // that timestamp, so they'd no-op anyway. Wipe to keep state
                // tidy.
                this.tombstones.clearAll();

                const report = await this.doForcePullAll();
                this.snapshot.runRetentionInBackground();

                // doForcePullAll already handled active-book reload via its
                // activeBookGone / activeBookOverwritten branches. Nothing
                // extra to do here, but warn if it logged errors.
                if (report.errors.length > 0) {
                    console.warn('[SyncService] restoreSnapshot: forcePull surfaced errors', report.errors);
                }
            } finally {
                this.restoreInProgress = false;
                this.scheduler.recordRun(true); // restore counts as a fresh start for the breaker
            }
        });
    }

}
