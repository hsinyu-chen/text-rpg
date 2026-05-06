import { DestroyRef, Injectable, effect, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { MatSnackBar } from '@angular/material/snack-bar';
import { WINDOW } from '@app/core/tokens/window.token';
import { GameStateService } from '../game-state.service';
import { SessionService } from '../session.service';
import { SyncBackendResolver } from './sync-backend-resolver.service';
import { S3ConfigService } from './s3-config.service';

const LS_DIRTY = 'sync_dirty';
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
    private readonly state = inject(GameStateService);
    private readonly backends = inject(SyncBackendResolver);
    private readonly s3Cfg = inject(S3ConfigService);
    private readonly snackBar = inject(MatSnackBar);

    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastSyncAt = 0;
    private failureCount = 0;

    /** Set by `register` so this service doesn't have to inject SyncService (circular). */
    private runner: (() => Promise<unknown>) | null = null;
    /**
     * Returns false to skip a scheduled run — owned by SyncService since
     * it knows about `restoreInProgress`. Without it, an auto-sync could
     * race a destructive op and leak mid-restore garbage cross-device.
     */
    private precondition: () => boolean = () => true;

    /**
     * Wire SyncService's `syncAll` runner + `restoreInProgress` guard.
     * Called once at SyncService construction. Until then `schedule` is
     * a no-op (defensive — UI signal effects can fire before wiring).
     */
    register(runner: () => Promise<unknown>, precondition: () => boolean): void {
        this.runner = runner;
        this.precondition = precondition;
        this.installListeners();
        this.installEffects();
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

    /** SyncService calls this after every public sync op completes (success or failure). */
    notifySyncCompleted(): void {
        this.lastSyncAt = Date.now();
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
            this.backends.setAutoSyncEnabled(id, false);
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

    private async run(): Promise<void> {
        this.timer = null;
        if (!this.isActive()) return;
        if (this.state.status() === 'generating') return;
        if (!this.runner) return;
        try {
            await this.runner();
            this.recordRun(true);
            this.lastSyncAt = Date.now();
        } catch (e) {
            console.warn(`[AutoSyncScheduler] Auto-sync failed (${this.failureCount + 1}/${MAX_FAILURES})`, e);
            this.recordRun(false);
        }
    }
}
