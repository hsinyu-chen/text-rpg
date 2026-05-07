import { Injectable, inject, signal } from '@angular/core';
import { StorageService } from '../storage.service';
import { SessionService } from '../session.service';
import { CollectionService } from '../collection.service';
import { GameStateService } from '../game-state.service';
import {
    SyncBackendId,
    SyncReport, ForcePushReport, ForcePullReport
} from './sync.types';
import { PromptCloudSyncService } from './prompt-cloud-sync.service';
import { SnapshotService } from './snapshot.service';
import { SyncBackendResolver } from './sync-backend-resolver.service';
import { AutoSyncScheduler } from './auto-sync-scheduler.service';
import { SyncReconciler } from './sync-reconciler.service';

export interface RemoteUpdateAvailable {
    bookId: string;
    remoteModifiedAt: number;
}

/**
 * Sync orchestration façade. Owns the public API surface (syncAll,
 * forcePush, forcePull, restoreSnapshot, settings/prompts blobs), the
 * `inFlight` mutex, and the post-reconcile session reload. Reconciliation
 * itself lives in `SyncReconciler`; auto-sync scheduling in
 * `AutoSyncScheduler`; backend resolution in `SyncBackendResolver`;
 * snapshot CRUD in `SnapshotService`.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
    private storage = inject(StorageService);
    private session = inject(SessionService);
    private collections = inject(CollectionService);
    private state = inject(GameStateService);
    private readonly promptCloudSync = inject(PromptCloudSyncService);
    private readonly snapshot = inject(SnapshotService);
    private readonly backends = inject(SyncBackendResolver);
    private readonly scheduler = inject(AutoSyncScheduler);
    private readonly reconciler = inject(SyncReconciler);

    /**
     * Set when a non-boot sync downloaded a newer version of the active book.
     * The toast prompts the user to load it; we don't silently swap because
     * the user might be mid-typing.
     */
    remoteUpdateAvailable = signal<RemoteUpdateAvailable | null>(null);

    private inFlight: { kind: 'sync' | 'forcePush' | 'forcePull' | 'restore' | 'auxiliary'; promise: Promise<unknown> } | null = null;
    /**
     * Set true while restoreSnapshot is rewriting state. Auto-sync would
     * race with the restore (its in-flight reads / writes get mixed in,
     * potentially propagating mid-restore garbage to other devices), so we
     * gate scheduling on this flag and refuse to schedule new runs until
     * restore is done.
     */
    private restoreInProgress = false;
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
        return this.runExclusive('sync', () => this.runSync());
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
        return this.runExclusive('sync', () => this.runSync());
    }

    private async runExclusive<T>(
        kind: 'sync' | 'forcePush' | 'forcePull' | 'restore' | 'auxiliary',
        fn: () => Promise<T>
    ): Promise<T> {
        while (this.inFlight) {
            try { await this.inFlight.promise; } catch { /* prior op's caller handles */ }
        }
        const promise = fn();
        const slot = { kind, promise };
        this.inFlight = slot;
        void promise.finally(() => {
            if (this.inFlight === slot) this.inFlight = null;
        });
        return promise;
    }

    private async runSync(): Promise<SyncReport> {
        const backend = await this.backends.getActiveBackend();
        await backend.authenticate();

        const { totals, downloadedBookIds, deletedBookIds } = await this.reconciler.reconcileAll(backend);

        await this.collections.load();
        await this.handleActiveBookAfterSync(downloadedBookIds, deletedBookIds);

        this.scheduler.notifySyncCompleted();
        return totals;
    }

    /**
     * After a two-way sync: if the active book was tombstoned by another
     * device, switch to the most-recently-active remaining book (or clear
     * the session). If it was downloaded but not deleted, silently reload
     * on boot, otherwise surface a toast — we don't wipe a user-open
     * session under the user mid-edit.
     */
    private async handleActiveBookAfterSync(
        downloadedBookIds: Set<string>,
        deletedBookIds: Set<string>
    ): Promise<void> {
        const currentId = this.session.currentBookId();
        if (!currentId) return;

        if (deletedBookIds.has(currentId)) {
            await this.fallbackToNextAvailableBook();
            return;
        }

        if (downloadedBookIds.has(currentId)) {
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
            const backend = await this.backends.getActiveBackend();
            await backend.authenticate();
            const report = await this.reconciler.forcePushAll(backend);
            this.snapshot.runRetentionInBackground();
            this.scheduler.notifySyncCompleted();
            return report;
        });
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
                await this.snapshot.createPreOpSnapshot('forcePull', 'local', () => this.reconciler.collectLocalSnapshotPayload());
            }
            const report = await this.runForcePull();
            this.snapshot.runRetentionInBackground();
            this.scheduler.notifySyncCompleted();
            return report;
        });
    }

    private async runForcePull(): Promise<ForcePullReport> {
        const backend = await this.backends.getActiveBackend();
        await backend.authenticate();
        const activeBookId = this.session.currentBookId();
        const { report, activeBookGone, activeBookOverwritten } =
            await this.reconciler.forcePullAll(backend, activeBookId);

        await this.collections.load();

        if (activeBookGone) {
            await this.fallbackToNextAvailableBook();
        } else if (activeBookOverwritten && activeBookId) {
            await this.session.loadBook(activeBookId, false);
        }

        return report;
    }

    /**
     * Active book disappeared (deleted by another device, or wiped by force-pull):
     * switch to the most-recently-active remaining book, or clear the in-memory
     * session signals if nothing's left. `false` on unloadCurrentSession skips
     * the auto-save that would otherwise re-create the deleted book.
     */
    private async fallbackToNextAvailableBook(): Promise<void> {
        const remaining = await this.storage.getBooks();
        if (remaining.length > 0) {
            const sorted = [...remaining].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
            await this.session.loadBook(sorted[0].id, false);
        } else {
            await this.session.unloadCurrentSession(false);
        }
    }

    /**
     * Auxiliary cloud ops (settings + prompts blobs) share the sync mutex.
     * Without this, two rapid push / pull clicks (or push concurrent with
     * an in-flight syncAll) race the GDrive `findXxxFileId` cache and can
     * leave duplicate `prompts.json` / `settings.json` orphans in appData.
     * They don't coalesce under 'sync' kind — each call queues distinctly.
     */
    async uploadSettings(content: string): Promise<void> {
        return this.runExclusive('auxiliary', async () => {
            const backend = await this.backends.getActiveBackend();
            await backend.authenticate();
            await backend.writeSettings(content);
        });
    }

    async downloadSettings(): Promise<string | null> {
        return this.runExclusive('auxiliary', async () => {
            const backend = await this.backends.getActiveBackend();
            await backend.authenticate();
            return backend.readSettings();
        });
    }

    async uploadPrompts(): Promise<{ exported: number }> {
        return this.runExclusive('auxiliary', () => this.promptCloudSync.uploadPrompts());
    }

    async downloadPrompts(): Promise<{ imported: number }> {
        return this.runExclusive('auxiliary', () => this.promptCloudSync.downloadPrompts());
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

                // runForcePull → reconciler.forcePullAll already wipes
                // tombstones (they're stale: restore wrote fresh tombstones
                // at Date.now() on cloud, predating any local pending).
                const report = await this.runForcePull();
                this.snapshot.runRetentionInBackground();

                // runForcePull already handled active-book reload via its
                // activeBookGone / activeBookOverwritten branches. Nothing
                // extra to do here, but warn if it logged errors.
                if (report.errors.length > 0) {
                    console.warn('[SyncService] restoreSnapshot: forcePull surfaced errors', report.errors);
                }

                // Stamp lastSyncAt + clear failure counter together. Without
                // this the visibility-cooldown re-trigger fires an immediate
                // redundant sync against just-restored state.
                this.scheduler.notifySyncCompleted();
            } finally {
                this.restoreInProgress = false;
            }
        });
    }

}
