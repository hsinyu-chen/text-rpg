import { DestroyRef, Directive, ElementRef, effect, inject, input } from '@angular/core';

/**
 * Sticky-bottom auto-scroll for streaming text containers. Pass the text
 * signal as the input; whenever it changes, the directive scrolls to the
 * bottom — but only if the user was already pinned there when the chunk
 * arrived, so manual scroll-up to review earlier content isn't yanked away.
 *
 * Used inside the SaveProgressDialog per-entry cards for the CoT `<pre>`
 * and structured-output `<pre>`. Both stream chunk-by-chunk from
 * SaveAgentRunner, and a long CoT would otherwise freeze the user's view at
 * the first line.
 *
 * **Why a scroll-event-driven flag instead of reading scrollHeight in the
 * effect:** Angular signal effects fire *after* the DOM mutation that
 * appended the new chunk, so `scrollHeight` at effect time already includes
 * the chunk. `distance = scrollHeight - scrollTop - clientHeight` would
 * therefore equal the chunk's pixel height, which routinely exceeds the
 * sticky threshold for multi-line JSON / CoT streams — auto-scroll would
 * permanently detach after the first sizable chunk. Instead, we capture
 * "was at bottom" on every scroll event (which fires only on `scrollTop`
 * changes, not on content growth) and the effect just reads that flag.
 */
@Directive({
    selector: '[appAutoScrollBottom]',
    standalone: true,
})
export class AutoScrollBottomDirective {
    private el = inject<ElementRef<HTMLElement>>(ElementRef);
    private destroyRef = inject(DestroyRef);

    /** Reactive value to watch — any change triggers the scroll check. */
    readonly content = input<string>('', { alias: 'appAutoScrollBottom' });

    /**
     * Latched-on-scroll: true when the user (or our last programmatic scroll)
     * left the viewport pinned within {@link STICKY_THRESHOLD_PX} of the
     * bottom. Starts true so the first chunk auto-scrolls.
     */
    private wasAtBottom = true;

    constructor() {
        const host = this.el.nativeElement;
        const onScroll = () => {
            this.wasAtBottom =
                host.scrollHeight - host.scrollTop - host.clientHeight <= STICKY_THRESHOLD_PX;
        };
        host.addEventListener('scroll', onScroll, { passive: true });
        this.destroyRef.onDestroy(() => host.removeEventListener('scroll', onScroll));

        effect(() => {
            this.content();
            if (!this.wasAtBottom) return;
            // queueMicrotask delays the scroll until the latest DOM mutation
            // for THIS effect run has settled, so we read the post-update
            // scrollHeight. The subsequent scroll event our assignment fires
            // refreshes `wasAtBottom` to `true`.
            queueMicrotask(() => {
                host.scrollTop = host.scrollHeight;
            });
        });
    }
}

/**
 * How close to the bottom the user must be (in px) for streaming-driven
 * auto-scroll to engage. 24px ≈ one line of text — generous enough to
 * survive jitter from anti-aliased line heights, tight enough that a user
 * who's actively reading mid-content isn't dragged back down.
 */
const STICKY_THRESHOLD_PX = 24;
