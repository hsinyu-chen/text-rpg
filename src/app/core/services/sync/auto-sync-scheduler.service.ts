import { DestroyRef, Injectable, effect, inject, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DOCUMENT } from '@angular/common';
import { MatSnackBar, MatSnackBarRef, TextOnlySnackBar } from '@angular/material/snack-bar';
import { EMPTY, Subject, from, of, timer } from 'rxjs';
import { catchError, concatMap, debounce, filter, tap } from 'rxjs/operators';
import { SessionService } from '../session.service';
import { SyncBackendResolver } from './sync-backend-resolver.service';
import { I18nService } from '@app/core/i18n';
import { SyncBackend } from './sync.types';

const DEBOUNCE_MS = 60_000;
const VISIBILITY_COOLDOWN_MS = 30_000;
const MAX_FAILURES = 3;

interface Trigger {
    /** True for visibility-cooldown / flush — bypass the debounce wait. */
    force: boolean;
}

/**
 * Auto-sync scheduling: rxjs-pipelined debounce + visibility-change hook
 * + failure-count circuit breaker. The pipeline is the entire flow;
 * `cancel()` is intentionally a no-op because state changes (autoSync
 * toggled off, backend swapped, restore in progress) are picked up by
 * the `filter()` at emission time.
 *
 * Lives separate from SyncService so the scheduling concern is testable
 * independent of the sync state machine, and so the visibility listener
 * isn't entangled with the public SyncService API.
 */
@Injectable({ providedIn: 'root' })
export class AutoSyncScheduler {
    private readonly doc = inject(DOCUMENT);
    private readonly destroyRef = inject(DestroyRef);
    private readonly session = inject(SessionService);
    private readonly backends = inject(SyncBackendResolver);
    private readonly snackBar = inject(MatSnackBar);
    private readonly i18n = inject(I18nService);

    private readonly trigger$ = new Subject<Trigger>();
    private lastSyncAt = 0;
    private failureCount = 0;
    /**
     * True between the moment a debounce-eligible trigger fires and the
     * moment the pipeline actually emits (i.e. the silence window has
     * elapsed). Gates `flush()` so a visibility-hidden event doesn't
     * force a sync when nothing's actually queued.
     */
    private pendingDebounce = false;
    /**
     * Set by `cancel()`, cleared on the next trigger. Read by the
     * pipeline's filter() to drop any debounce-pending emission whose
     * trigger predates a cancel call. Without this, the rxjs
     * `debounce(timer)` would still fire after a `restoreSnapshot`
     * completes and trigger a redundant syncAll against the freshly
     * restored state.
     */
    private cancelled = false;
    /**
     * The currently-visible auth-lapse snackbar, if any. MatSnackBar
     * auto-dismisses an open snackbar when a new one opens — that
     * displacement fires the OLD ref's afterDismissed with
     * dismissedByAction=false, which would prematurely disable
     * auto-sync. We compare against this ref so only the latest
     * snackbar's natural dismissal counts.
     */
    private currentAuthSnackbar: MatSnackBarRef<TextOnlySnackBar> | null = null;

    /** Set by `register` so this service doesn't have to inject SyncService (circular). */
    private runner: (() => Promise<unknown>) | null = null;
    /**
     * Returns false to skip a scheduled run — owned by SyncService since
     * it knows about `restoreInProgress` and the game-engine generating
     * status. Without it, an auto-sync could race a destructive op and
     * leak mid-restore garbage cross-device.
     */
    private precondition: () => boolean = () => true;

    constructor() {
        this.installListeners();
        this.installEffects();
        this.installPipeline();
    }

    /**
     * Wire SyncService's `syncAll` runner + `restoreInProgress` /
     * `generating` precondition. Called once at SyncService construction.
     * Until then the pipeline filter() will drop emissions on the
     * `!this.runner` check.
     */
    register(runner: () => Promise<unknown>, precondition: () => boolean): void {
        if (this.runner) {
            // Idempotent — second call would be a wiring mistake. In
            // practice only SyncService calls this, exactly once.
            return;
        }
        this.runner = runner;
        this.precondition = precondition;
    }

    /**
     * True iff the active backend supports background sync, is ready,
     * is authenticated, and SyncService's precondition allows it. Used
     * by both UI ("is auto-sync currently effective?") and the pipeline
     * filter.
     *
     * `isAuthenticated()` matters for backends whose auth lapses outside
     * a user gesture (File: FSA transient grant; future: GDrive OAuth
     * with expired token). Without this check the scheduler would burn
     * the circuit breaker hitting an unauthenticated backend on every
     * save.
     */
    isActive(): boolean {
        if (!this.precondition()) return false;
        const id = this.backends.activeBackendId();
        if (!this.backends.autoSyncEnabled()[id]) return false;
        const b = this.backends.get(id);
        return !!b?.supportsBackgroundSync && b.isReady() && b.isAuthenticated();
    }

    schedule(immediate = false): void {
        if (this.failureCount >= MAX_FAILURES) return;
        this.trigger$.next({ force: immediate });
    }

    flush(): void {
        // Only force a run if we actually have a debounce window open.
        // Without this guard, every visibility-hidden would kick a sync
        // even when nothing changed since the last one.
        if (!this.pendingDebounce) return;
        this.trigger$.next({ force: true });
    }

    /**
     * Cancel any pending debounced emission. Called by SyncService.
     * restoreSnapshot before its destructive op so the 60s timer that
     * was set by a save BEFORE the restore doesn't fire AFTER the
     * restore completes (`restoreInProgress` flips back to false in
     * the finally block; without this flag the late emission would
     * pass the filter and run a redundant syncAll against the freshly
     * restored state).
     *
     * The next `trigger$.next()` clears the flag — cancellation is
     * one-shot, doesn't suppress future schedules.
     */
    cancel(): void {
        this.cancelled = true;
    }

    /**
     * SyncService calls this after a public sync op (`syncAll` /
     * `forcePushAll` / `forcePullAll` / `restoreSnapshot`) finishes
     * successfully. The timestamp gates the visibility-cooldown re-trigger;
     * failures don't update it (we want the next visible-tab to retry promptly).
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
        // No timer to clear — the pipeline's filter() drops in-debounce
        // emissions when the new backend doesn't satisfy isActive().
    }

    /**
     * SyncService.setAutoSyncEnabled wrapper hook: user toggled the flag.
     * The toggle direction (`on`) is irrelevant here — the pipeline's
     * filter() drops in-flight emissions when the resolver flag flipped
     * to false. We only need to reset the breaker either way so the
     * next user-driven re-enable starts clean.
     */
    onAutoToggle(): void {
        this.failureCount = 0;
    }

    /**
     * Feed the circuit breaker from a sync run that ran *outside* the
     * scheduler's own pipeline (currently `bootSync`). Success resets
     * the counter; failure increments and may disable auto-sync + toast
     * on hitting `MAX_FAILURES`.
     */
    recordRun(success: boolean): void {
        if (success) {
            this.failureCount = 0;
            return;
        }
        this.failureCount++;
        if (this.failureCount >= MAX_FAILURES) {
            const id = this.backends.activeBackendId();
            const b = this.backends.get(id);

            if (b && !b.isAuthenticated()) {
                // If it failed because of auth (e.g. FSA grant expired),
                // give user a chance to re-grant before disabling.
                this.showAuthLapseSnackbar(b);
            } else {
                this.backends.setAutoSyncEnabled(id, false);
                this.snackBar.open(
                    this.i18n.translate('sync.autoSync.disabledAfterFailures', { max: MAX_FAILURES }),
                    this.i18n.translate('ui.CLOSE'),
                    { duration: 8000 }
                );
            }
        }
    }

    private installPipeline(): void {
        this.trigger$
            .pipe(
                tap(() => {
                    this.pendingDebounce = true;
                    this.cancelled = false;
                }),
                // `force` triggers (visibility flush, schedule(immediate))
                // bypass the debounce wait. Otherwise wait for 60s of
                // silence before emitting. concatMap below serializes —
                // emissions during an in-flight run queue and play out
                // afterward, so changes that arrived mid-sync don't get
                // dropped.
                debounce((t: Trigger) => t.force ? of(0) : timer(DEBOUNCE_MS)),
                tap(() => { this.pendingDebounce = false; }),
                filter(() => !this.cancelled && this.runner !== null && this.isActive()),
                concatMap(() => {
                    // Defensive: an async runner converts throws to
                    // rejected promises, but `this.runner!()` itself
                    // could synchronously throw (e.g. null-deref on a
                    // future refactor). Catching here prevents the
                    // outer subscription from terminating permanently.
                    try {
                        return from(this.runner!()).pipe(
                            // No tap-success: the runner is syncAll which
                            // already calls notifySyncCompleted on success
                            // (which resets failureCount). Recording again
                            // here would be redundant.
                            tap({
                                error: e => {
                                    console.warn(
                                        `[AutoSyncScheduler] Auto-sync failed (${this.failureCount + 1}/${MAX_FAILURES})`,
                                        e
                                    );
                                    this.recordRun(false);
                                }
                            }),
                            catchError(() => EMPTY)
                        );
                    } catch (e) {
                        console.error('[AutoSyncScheduler] Runner threw synchronously', e);
                        this.recordRun(false);
                        return EMPTY;
                    }
                }),
                takeUntilDestroyed(this.destroyRef)
            )
            .subscribe();
    }

    private installListeners(): void {
        // Listeners are kept alive for the entire app lifetime in production
        // (the service is providedIn: 'root'), but tests recreate the service
        // and would otherwise leak listeners onto the shared document/window.
        const onVisibilityChange = () => {
            if (this.doc.visibilityState === 'hidden') {
                this.flush();
            } else if (this.doc.visibilityState === 'visible') {
                if (Date.now() - this.lastSyncAt > VISIBILITY_COOLDOWN_MS) {
                    this.schedule(true);
                }
            }
        };
        this.doc.addEventListener('visibilitychange', onVisibilityChange);
        this.destroyRef.onDestroy(() => {
            this.doc.removeEventListener('visibilitychange', onVisibilityChange);
        });
    }

    private installEffects(): void {
        // React to every successful book save → schedule debounced auto-sync.
        effect(() => {
            const ts = this.session.lastSavedAt();
            if (ts > 0) this.schedule();
        });

        // Reset the circuit breaker when ANY backend's config changes —
        // the previous failures were against the OLD config (creds /
        // OAuth tokens / FSA handle), so they shouldn't keep auto-sync
        // disabled for the new one. Routed through SyncBackend.
        // configFingerprint() so the scheduler doesn't have to know
        // backend-specific config services.
        //
        // Same effect also auto-disables the auto-sync flag when an
        // already-enabled backend loses authentication — e.g. an FSA
        // transient grant expires after a reload. Otherwise the toggle
        // would stay on while the pipeline's isActive() silently drops
        // every emission, and the user wouldn't know background sync
        // had stopped.
        const lastFingerprints = new Map<string, string>();
        effect(() => {
            for (const b of this.backends.list()) {
                const fp = b.configFingerprint();
                const prev = lastFingerprints.get(b.id);
                lastFingerprints.set(b.id, fp);
                // Skip by value, not by `prev === undefined`: if the
                // backend's async restore() resolves before this effect's
                // first tick, prev would be undefined yet fp would already
                // be in its resolved state. Treating that as "no change"
                // would miss a real auth lapse (e.g. autoSync=on from KV
                // but FSA transient grant already dropped to 'prompt').
                if (prev === fp) continue;
                if (fp === '' || fp.endsWith(':unknown')) continue;
                this.failureCount = 0;
                // Only prompt for the active backend — the scheduler only
                // processes the active one, so a lapse on an inactive
                // backend is harmless until the user swaps to it. Showing
                // its snackbar now would be noise.
                if (
                    b.id === this.backends.activeBackendId()
                    && this.backends.autoSyncEnabled()[b.id]
                    && !b.isAuthenticated()
                ) {
                    // untracked: this effect READS autoSyncEnabled() above
                    // for the condition; writing it from inside would form
                    // a self-trigger cycle without untracked.
                    untracked(() => {
                        this.showAuthLapseSnackbar(b);
                    });
                }
            }
        });
    }

    private showAuthLapseSnackbar(b: SyncBackend): void {
        const ref = this.snackBar.open(
            this.i18n.translate('sync.autoSync.permissionRegrantNeeded', { label: b.label }),
            b.authActionLabel,
            { duration: 8000 }
        );
        this.currentAuthSnackbar = ref;

        ref.onAction().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
            b.authenticate().then(() => {
                // Successful re-auth: clear the circuit breaker and kick an
                // immediate run so the user doesn't have to wait for the
                // next save to see sync resume.
                this.failureCount = 0;
                this.schedule(true);
            }).catch(err => {
                console.error(`[AutoSync] Failed to re-authenticate backend ${b.id}:`, err);
                this.backends.setAutoSyncEnabled(b.id, false);
            });
        });

        ref.afterDismissed().pipe(takeUntilDestroyed(this.destroyRef)).subscribe(dismiss => {
            // Stale dismissal (this ref was displaced by a newer auth
            // snackbar): swallow — the newer one owns the grace period.
            if (this.currentAuthSnackbar !== ref) return;
            this.currentAuthSnackbar = null;
            // Re-check auth: timeout (8s is short) or user fixing the
            // grant via the settings page should NOT disable. Only the
            // user actively ignoring an unresolved prompt does.
            if (!dismiss.dismissedByAction && !b.isAuthenticated()) {
                this.backends.setAutoSyncEnabled(b.id, false);
            }
        });
    }
}
