import { DestroyRef, Injectable, effect, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { MatSnackBar } from '@angular/material/snack-bar';
import { WINDOW } from '@app/core/tokens/window.token';
import { SessionService } from '../session.service';
import { SyncBackendResolver } from './sync-backend-resolver.service';
import { S3ConfigService } from './s3-config.service';

/**
 * localStorage flag set on pagehide if a debounced sync was pending,
 * read on next boot to force an initial sync. Internal to the scheduler;
 * SyncService clears it via `clearDirtyFlag()`.
 */
const LS_SYNC_DIRTY = 'sync_dirty';
const DEBOUNCE_MS = 60_000;
const VISIBILITY_COOLDOWN_MS = 30_000;
const MAX_FAILURES = 3;

/**
 * Auto-sync scheduling: debounce timer + visibility / pagehide hooks +
 * failure-count circuit breaker. Owns all timing state; SyncService
 * supplies the actual sync runner and a precondition probe (restore in
 * progress, etc).
 *
 * Lives separate from SyncService so the scheduling concern is testable
 * independent of the sync state machine, and so the visibility / pagehide
 * listeners aren't entangled with the public SyncService API.
 */
@Injectable({ providedIn: 'root' })
export class AutoSyncScheduler {
    private readonly doc = inject(DOCUMENT);
    private readonly win = inject(WINDOW);
    private readonly destroyRef = inject(DestroyRef);
    private readonly session = inject(SessionService);
    private readonly backends = inject(SyncBackendResolver);
    private readonly s3Cfg = inject(S3ConfigService);
    private readonly snackBar = inject(MatSnackBar);

    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastSyncAt = 0;
    private failureCount = 0;
    private runInFlight: Promise<void> | null = null;

    /** Set by `register` so this service doesn't have to inject SyncService (circular). */
    private runner: (() => Promise<unknown>) | null = null;
    /**
     * Returns false to skip a scheduled run — owned by SyncService since
     * it knows about `restoreInProgress`. Without it, an auto-sync could
     * race a destructive op and leak mid-restore garbage cross-device.
     */
    private precondition: () => boolean = () => true;

    constructor() {
        // Listeners + effects MUST be installed in an injection context.
        // We can't defer them to register() because tests (or any caller
        // outside a DI scope) would hit `NG0203: effect() can only be
        // used within an injection context`. The early-effect firings
        // before the runner is wired are safe — `run()` bails on the
        // `!this.runner` guard.
        this.installListeners();
        this.installEffects();
    }

    /**
     * Wire SyncService's `syncAll` runner + `restoreInProgress` guard.
     * Called once at SyncService construction. Until then `schedule` is
     * a no-op (defensive — UI signal effects can fire before wiring).
     */
    register(runner: () => Promise<unknown>, precondition: () => boolean): void {
        if (this.runner) {
            // Idempotent — second call would double-handle every event.
            // In practice only SyncService calls this, exactly once.
            return;
        }
        this.runner = runner;
        this.precondition = precondition;
    }

    /**
     * True iff the active backend supports background sync, is ready,
     * and SyncService's precondition allows it. Used by both UI ("is
     * auto-sync currently effective?") and internal scheduling.
     */
    isActive(): boolean {
        if (!this.precondition()) return false;
        const id = this.backends.activeBackendId();
        if (!this.backends.autoSyncEnabled()[id]) return false;
        const b = this.backends.get(id);
        return !!b?.supportsBackgroundSync && b.isReady();
    }

    schedule(immediate = false): void {
        if (!this.isActive()) return;
        if (this.failureCount >= MAX_FAILURES) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.run(), immediate ? 0 : DEBOUNCE_MS);
    }

    async flush(): Promise<void> {
        if (!this.timer) return;
        clearTimeout(this.timer);
        this.timer = null;
        await this.run();
    }

    cancel(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * SyncService calls this after a public sync op (`doSyncAll` /
     * `doForcePushAll` / `doForcePullAll`) finishes successfully. The
     * timestamp gates the visibility-cooldown re-trigger; failures
     * don't update it (we want the next visible-tab to retry promptly).
     *
     * Also resets the failure-count circuit breaker — a successful
     * manual sync proves the backend is reachable, so any prior
     * auto-sync failures shouldn't keep the breaker tripped.
     */
    notifySyncCompleted(): void {
        this.lastSyncAt = Date.now();
        this.failureCount = 0;
    }

    /** SyncService.setActiveBackend wrapper hook: backend choice changed. */
    onBackendChanged(): void {
        this.failureCount = 0;
        this.cancel();
    }

    /** SyncService.setAutoSyncEnabled wrapper hook: user toggled the flag. */
    onAutoToggle(on: boolean): void {
        this.failureCount = 0;
        if (!on) this.cancel();
    }

    /**
     * Clear the dirty flag. SyncService calls this after a successful
     * bootSync (or when there's no auto-sync to drain). Encapsulates the
     * LS_SYNC_DIRTY key inside the scheduler so SyncService doesn't have
     * to know it exists.
     */
    clearDirtyFlag(): void {
        localStorage.removeItem(LS_SYNC_DIRTY);
    }

    /**
     * Feed the circuit breaker from a sync run that ran *outside* the
     * scheduler's own debounce timer (currently `bootSync`). Success
     * resets the counter; failure increments and may disable auto-sync
     * + toast on hitting `MAX_FAILURES`. Mirrors the in-scheduler `run`
     * accounting so any caller-driven sync attempt feeds the same brake.
     */
    recordRun(success: boolean): void {
        if (success) {
            this.failureCount = 0;
            return;
        }
        this.failureCount++;
        if (this.failureCount >= MAX_FAILURES) {
            const id = this.backends.activeBackendId();
            // We bypass SyncService's thin setAutoSyncEnabled wrapper
            // here (calling resolver directly), which means our own
            // onAutoToggle hook doesn't fire — clear the pending timer
            // explicitly so a debounced run isn't left to no-op later.
            this.backends.setAutoSyncEnabled(id, false);
            this.cancel();
            this.snackBar.open(
                `Auto-sync disabled after ${MAX_FAILURES} failures. Re-enable in Settings once fixed.`,
                'Close',
                { duration: 8000 }
            );
        }
    }

    private installListeners(): void {
        // Listeners are kept alive for the entire app lifetime in production
        // (the service is providedIn: 'root'), but tests recreate the service
        // and would otherwise leak listeners onto the shared document/window.
        const onVisibilityChange = () => {
            if (this.doc.visibilityState === 'hidden') {
                void this.flush();
            } else if (this.doc.visibilityState === 'visible') {
                if (Date.now() - this.lastSyncAt > VISIBILITY_COOLDOWN_MS) {
                    this.schedule(true);
                }
            }
        };
        const onPageHide = () => {
            if (this.timer) {
                localStorage.setItem(LS_SYNC_DIRTY, '1');
            }
        };
        this.doc.addEventListener('visibilitychange', onVisibilityChange);
        this.win.addEventListener('pagehide', onPageHide);
        this.destroyRef.onDestroy(() => {
            // Clear any in-flight debounce so a test that recreates the
            // service doesn't leave a dangling setTimeout that fires
            // against a torn-down DI graph.
            this.cancel();
            this.doc.removeEventListener('visibilitychange', onVisibilityChange);
            this.win.removeEventListener('pagehide', onPageHide);
        });
    }

    private installEffects(): void {
        // React to every successful book save → schedule debounced auto-sync.
        effect(() => {
            const ts = this.session.lastSavedAt();
            if (ts > 0) this.schedule();
        });

        // Reset the circuit breaker when the user changes the S3 config —
        // the previous failures were against the OLD creds, so they
        // shouldn't keep auto-sync disabled for the new ones. Tracks
        // both first-load (`config()` flips from null to set) and edits
        // (fingerprint changes via signal mutation in S3ConfigService.save).
        let lastS3Fingerprint = '';
        effect(() => {
            const c = this.s3Cfg.config();
            const fp = c ? JSON.stringify(c) : '';
            if (fp !== lastS3Fingerprint) {
                lastS3Fingerprint = fp;
                this.failureCount = 0;
            }
        });
    }

    private run(): Promise<void> {
        // Clear the timer FIRST regardless of in-flight state. Otherwise
        // a stale timeout id sticks around after the setTimeout fired,
        // and pagehide / flush / cancel would mis-detect "a debounced
        // sync is pending" and (e.g.) set LS_SYNC_DIRTY incorrectly.
        this.timer = null;
        if (this.runInFlight) {
            // Single-flight: don't queue a second run behind SyncService's
            // own inFlight mutex. But we DO need to ensure changes that
            // arrived during the in-flight window get synced — the active
            // run captured a snapshot of state from before this trigger,
            // so re-arm a debounced follow-up once it completes. Without
            // the follow-up, returning the shared promise silently drops
            // any change that fired schedule() while a sync was running.
            void this.runInFlight.finally(() => this.schedule());
            return this.runInFlight;
        }
        if (!this.isActive()) return Promise.resolve();
        if (!this.runner) return Promise.resolve();
        this.runInFlight = this.doRun().finally(() => { this.runInFlight = null; });
        return this.runInFlight;
    }

    private async doRun(): Promise<void> {
        try {
            await this.runner!();
            // syncAll already called notifySyncCompleted on the success
            // branch; recordRun is for the failure-counter only.
            this.recordRun(true);
        } catch (e) {
            console.warn(`[AutoSyncScheduler] Auto-sync failed (${this.failureCount + 1}/${MAX_FAILURES})`, e);
            this.recordRun(false);
        }
    }
}
