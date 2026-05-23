import { DestroyRef, Directive, ElementRef, effect, inject, input, output } from '@angular/core';

/**
 * Sticky-bottom auto-scroll for streaming content. The directive lives on the
 * scroll container; whenever the watched input signal changes (or — when
 * `observeResize` is on — when content inside the container grows), the
 * directive re-pins to the bottom, gated by an "is the user driving?" flag.
 *
 * **Intent-based, not distance-based.** A single big chunk can push the user
 * 5000 px above the bottom in one frame — any distance threshold would
 * permanently detach. Detach is triggered by two complementary signals:
 *   - **wheel / touchstart / keydown** events on the host: fire only when
 *     the user is driving, latch detach synchronously with zero delay
 *   - **scroll events where scrollTop *decreased*** (delta-up): catches
 *     mouse-drag on the scrollbar, which produces no wheel/touch/key event
 *     but emits scroll events with decreasing scrollTop. Our programmatic
 *     writes always target scrollHeight (downward), so scrollTop never
 *     decreases under our control — delta-up is unambiguously user intent.
 *
 * The user re-engages auto-follow by scrolling into the bottom-ack zone
 * (50 px) — same scroll handler.
 *
 * `threshold` controls when the directive emits `atBottom` (for a host's
 * "scroll to bottom" button visibility) — it does NOT gate auto-follow.
 */
@Directive({
    selector: '[appAutoScrollBottom]',
    standalone: true,
    exportAs: 'autoScroll',
})
export class AutoScrollBottomDirective {
    private el = inject<ElementRef<HTMLElement>>(ElementRef);
    private destroyRef = inject(DestroyRef);

    /** Reactive value to watch — any change triggers a scroll check. */
    readonly content = input<unknown>(null, { alias: 'appAutoScrollBottom' });

    /** Distance below which `atBottom` emits `true` (px). Does NOT gate
     *  auto-follow — that's purely user-intent-driven. Controls the
     *  "scroll to bottom" button's visibility hysteresis only. */
    readonly threshold = input<number>(STICKY_THRESHOLD_PX);

    /** Behavior for IMPERATIVE `scrollToBottom()` calls (e.g. host's "scroll
     *  to bottom" button). `instant` = direct `scrollTop` write; `smooth` =
     *  `scrollTo({behavior:'smooth'})`. **Automatic auto-follow always uses
     *  instant** regardless of this setting — smooth retargeting can't keep
     *  pace with rapid streaming chunks and causes visible drift behind the
     *  content. The frequent small instant writes during streaming read as
     *  smooth at 60 fps already. */
    readonly scrollMode = input<'instant' | 'smooth'>('instant');

    /** When true, attach a `ResizeObserver` to the host's first child so
     *  content growth (without a signal change) also triggers auto-follow.
     *  Required for hosts where chunks land via child-component DOM writes
     *  the parent's signal doesn't see (chat-message streaming, agent log
     *  CoT expansion). Falls back to host when there's no element child. */
    readonly observeResize = input<boolean>(false);

    /** Re-pin to bottom for up to 30 RAF×2 ticks after each scroll, until
     *  `dist ≤ 1` or `scrollHeight` stops growing. Catches layout shifts
     *  that happen *after* the initial scroll resolves — `content-visibility:auto`
     *  reveal, lazy image load, expansion-panel open, font swap, etc. Opt-in
     *  because the safety cap is wasted work where post-scroll layout is stable. */
    readonly stabilizeOnScroll = input<boolean>(false);

    /** External gate: while true, all auto-follow paths no-op. Explicit
     *  `scrollToBottom()` calls (e.g. a button click) still proceed —
     *  user intent overrides the pause. */
    readonly paused = input<boolean>(false);

    /** Fires when the at-bottom state crosses the `threshold` boundary
     *  (and once on first measurement). Host typically binds it to a
     *  signal that drives a "scroll to bottom" button's visibility. */
    readonly atBottom = output<boolean>();

    /** User-intent flag: true while the user is following the bottom of
     *  the stream. Flipped false by genuine user input (wheel / touch /
     *  keyboard nav) OR a scroll event with scrollTop decreased by more
     *  than {@link SCROLL_UP_DELTA_PX} (mouse-drag of the scrollbar).
     *  Flipped true when the position returns to the 50 px bottom-ack zone.
     *  Starts true so the first chunk auto-scrolls. */
    private wasAtBottom = true;
    private lastScrollTop = 0;
    private rafId: number | null = null;
    private lastEmittedAtBottom: boolean | null = null;
    /** Set while an imperative smooth scroll-to-bottom is animating.
     *  Auto-follow is suppressed in this window so a content-driven
     *  re-pin doesn't instant-jump and cut the smooth tail short. */
    private smoothInFlight = false;
    private smoothFallbackTimerId: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        const host = this.el.nativeElement;

        // User-input handlers: real user events fire ONLY when the user is
        // driving, never during our programmatic `scrollTo`. Synchronously
        // latch wasAtBottom=false so the very next content tick (which often
        // lands the same frame as the wheel event in fast LLM streams) sees
        // the detach and skips re-pinning. Distance-delta detection in the
        // scroll handler was too slow + jittery for this — scroll events lag
        // wheel events by ~1 frame, and during that frame a fresh chunk +
        // RAF re-pin can race the user's intent.
        const onUserDrive = () => {
            this.wasAtBottom = false;
            // User took over — release the smooth-in-flight suppress so
            // subsequent content arrivals can re-pin (when wasAtBottom returns
            // to true via the ack zone) without waiting for the now-aborted
            // browser smooth animation's never-firing scrollend.
            this.clearSmoothInFlight();
        };
        host.addEventListener('wheel', onUserDrive, { passive: true });
        host.addEventListener('touchstart', onUserDrive, { passive: true });
        host.addEventListener('keydown', onUserDrive, { passive: true });

        const onScroll = () => {
            const dist = host.scrollHeight - host.scrollTop - host.clientHeight;
            const scrollTop = host.scrollTop;
            // Re-engage auto-follow when the user (or our programmatic
            // scroll's tail) lands within the bottom-ack zone.
            if (dist < BOTTOM_ACK_PX) {
                this.wasAtBottom = true;
            } else if (scrollTop < this.lastScrollTop - SCROLL_UP_DELTA_PX) {
                // scrollTop went up — only user input can do that since our
                // programmatic writes always target scrollHeight. Catches
                // mouse-drag of the scrollbar (which doesn't fire wheel /
                // touch / key) and is a redundant safety net for those that do.
                this.wasAtBottom = false;
                this.clearSmoothInFlight();
            }
            this.lastScrollTop = scrollTop;
            this.emitAtBottom(dist <= this.threshold());
        };
        // scrollend fires when a smooth animation finishes naturally.
        // Chrome 114+, Firefox 121+, Safari 18.2+. Older browsers fall back
        // to the SMOOTH_FALLBACK_MS timeout in `doScroll`.
        const onScrollEnd = () => this.clearSmoothInFlight();
        host.addEventListener('scroll', onScroll, { passive: true });
        host.addEventListener('scrollend', onScrollEnd, { passive: true });
        this.destroyRef.onDestroy(() => {
            host.removeEventListener('wheel', onUserDrive);
            host.removeEventListener('touchstart', onUserDrive);
            host.removeEventListener('keydown', onUserDrive);
            host.removeEventListener('scroll', onScroll);
            host.removeEventListener('scrollend', onScrollEnd);
        });

        // Signal-driven trigger (existing behavior — watched value changes ⇒ check).
        effect(() => {
            this.content();
            this.scheduleAutoScroll();
        });

        // ResizeObserver trigger (opt-in). Observes the first child so content
        // growth inside a fixed-height scroll container fires (the container's
        // own box doesn't change). Falls back to host when there's no child.
        effect((onCleanup) => {
            if (!this.observeResize()) return;
            const target = host.firstElementChild ?? host;
            const ro = new ResizeObserver(() => this.scheduleAutoScroll());
            ro.observe(target);
            onCleanup(() => ro.disconnect());
        });

        this.destroyRef.onDestroy(() => {
            if (this.rafId !== null) cancelAnimationFrame(this.rafId);
            this.clearSmoothInFlight();
        });
    }

    /** Imperative scroll-to-bottom (button click etc.). Ignores `paused()` —
     *  explicit user intent beats any in-flight gate. */
    scrollToBottom(forceInstant = false): void {
        // Only reset wasAtBottom for instant scrolls. For smooth, leave it
        // false until the scroll event listener naturally flips it true at
        // dist<50 — otherwise `scheduleScrollCorrection`'s gate
        // `!wasAtBottom → return` is bypassed, its first RAF×2 re-pin uses
        // `behavior:'auto'` (instant), and that cancels the in-flight smooth
        // animation. The animation completes naturally and flips wasAtBottom
        // for us within ~300ms.
        if (forceInstant) {
            this.wasAtBottom = true;
        }
        this.doScroll(forceInstant, /* fromImperative= */ true);
    }

    /** Snapshot of the sticky-follow flag — true when the user hasn't manually
     *  scrolled up since the last bottom-ack. Hosts read this to gate "snap to
     *  bottom on status change" safety nets so a reader reviewing earlier
     *  content isn't yanked back. */
    isFollowing(): boolean {
        return this.wasAtBottom;
    }

    private scheduleAutoScroll(): void {
        // Cancel any pending RAF before the paused-gate so a pause that
        // arrives between scheduling and firing drops the queued trigger
        // instead of letting performAutoScroll re-check at fire time.
        // Symmetric with the cancel-then-schedule on the normal path below.
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (this.paused()) return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = null;
            this.performAutoScroll();
        });
    }

    private performAutoScroll(): void {
        if (this.paused() || !this.wasAtBottom) return;
        // Suppress auto-follow while a smooth imperative scroll is animating.
        // Otherwise the content tick lands an instant `scrollTop = ...` which
        // cancels the smooth animation mid-way and cuts the tail. The smooth
        // scroll completes naturally; subsequent content arrivals after
        // scrollend resume auto-follow at the new bottom.
        if (this.smoothInFlight) return;
        const host = this.el.nativeElement;
        if (host.scrollHeight <= host.clientHeight) return;
        // No distance gate — wasAtBottom is the sole follow predicate.
        // A 5000 px chunk in one frame must still pin, and only a user-driven
        // wheel/touch/key event detaches.
        // Always instant for auto-follow regardless of scrollMode — smooth
        // retargeting can't keep pace with rapid streaming chunks and lags
        // visibly behind the content. See `scrollMode` docs.
        this.doScroll(/* forceInstant= */ true, /* fromImperative= */ false);
    }

    private doScroll(forceInstant: boolean, fromImperative: boolean): void {
        const host = this.el.nativeElement;
        const useInstant = forceInstant || this.scrollMode() === 'instant';
        try {
            if (useInstant) {
                host.scrollTop = host.scrollHeight;
            } else {
                host.scrollTo({ top: host.scrollHeight, behavior: 'smooth' });
                if (fromImperative) {
                    // Track smooth-in-flight only for IMPERATIVE smooth (e.g.
                    // button click) — auto-follow never asks for smooth, so
                    // we'd never set this from the auto path anyway. Cleared
                    // on scrollend, on user-drive (wheel/touch/key — browser
                    // cancels the smooth then), or by the fallback timeout
                    // for browsers without scrollend support.
                    this.smoothInFlight = true;
                    if (this.smoothFallbackTimerId !== null) {
                        clearTimeout(this.smoothFallbackTimerId);
                    }
                    this.smoothFallbackTimerId = setTimeout(
                        () => this.clearSmoothInFlight(),
                        SMOOTH_FALLBACK_MS,
                    );
                }
            }
            if (this.stabilizeOnScroll()) {
                this.scheduleScrollCorrection(host, useInstant);
            }
        } catch { /* ignore — scrollTo can throw in detached test envs */ }
    }

    private clearSmoothInFlight(): void {
        this.smoothInFlight = false;
        if (this.smoothFallbackTimerId !== null) {
            clearTimeout(this.smoothFallbackTimerId);
            this.smoothFallbackTimerId = null;
        }
    }

    private scheduleScrollCorrection(
        el: HTMLElement,
        force: boolean,
        attempt = 0,
        lastHeight = -1
    ): void {
        if (attempt >= STABILIZE_MAX_ATTEMPTS) return;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (this.paused() || !this.wasAtBottom) return;
                const curr = el.scrollHeight;
                const dist = curr - el.scrollTop - el.clientHeight;
                if (dist <= 1) return;
                // Layout has stabilised but we're still short — further retries won't help.
                if (curr === lastHeight) return;
                if (force) {
                    el.scrollTop = curr;
                } else {
                    el.scrollTo({ top: curr, behavior: 'auto' });
                }
                this.scheduleScrollCorrection(el, force, attempt + 1, curr);
            });
        });
    }

    private emitAtBottom(v: boolean): void {
        if (v === this.lastEmittedAtBottom) return;
        this.lastEmittedAtBottom = v;
        this.atBottom.emit(v);
    }
}

/** Default sticky distance (px). One line of text ≈ 24 px — generous enough
 *  to survive anti-aliased line-height jitter, tight enough that a reader
 *  actively reviewing mid-content isn't dragged back down. */
const STICKY_THRESHOLD_PX = 24;
/** Returning within this distance re-engages auto-follow. */
const BOTTOM_ACK_PX = 50;
/** Minimum upward scrollTop delta (px) to count as user-initiated scroll-up.
 *  Below this, treat as jitter (browser interpolation drift, sub-pixel
 *  reflow). 5 px ≈ half a wheel notch — generous enough to suppress noise,
 *  tight enough that a deliberate mouse-drag registers immediately. */
const SCROLL_UP_DELTA_PX = 5;
/** Fallback for browsers without `scrollend` event (pre-Chrome 114 / FF 121 /
 *  Safari 18.2). Long enough to outlast a slow smooth scroll from the top
 *  of a tall container; short enough that a missed scrollend doesn't
 *  permanently freeze auto-follow. */
const SMOOTH_FALLBACK_MS = 1200;
/** Safety cap on `scheduleScrollCorrection` recursion. */
const STABILIZE_MAX_ATTEMPTS = 30;
