import { Directive, ElementRef, effect, inject, input } from '@angular/core';

/**
 * Sticky-bottom auto-scroll for streaming text containers. Pass the text
 * signal as the input; the directive re-runs `scrollTop = scrollHeight`
 * whenever the value changes — but only if the user was already pinned to
 * the bottom (within {@link STICKY_THRESHOLD_PX}), so manual scroll-up to
 * review earlier content isn't yanked away by the next stream chunk.
 *
 * Used inside the SaveProgressDialog per-entry cards for the CoT `<pre>`
 * and structured-output `<pre>`. Both stream chunk-by-chunk from
 * SaveAgentRunner, and a long CoT would otherwise freeze the user's view at
 * the first line.
 */
@Directive({
    selector: '[appAutoScrollBottom]',
    standalone: true,
})
export class AutoScrollBottomDirective {
    private el = inject<ElementRef<HTMLElement>>(ElementRef);
    /** Reactive value to watch — any change triggers the scroll check. */
    readonly content = input<string>('', { alias: 'appAutoScrollBottom' });

    constructor() {
        effect(() => {
            this.content();
            const host = this.el.nativeElement;
            // Reading scrollHeight + clientHeight inside an effect is fine —
            // they're synchronous DOM reads, and the effect itself runs after
            // Angular has applied the template update for this CD pass.
            const distanceFromBottom = host.scrollHeight - host.scrollTop - host.clientHeight;
            if (distanceFromBottom <= STICKY_THRESHOLD_PX) {
                // queueMicrotask delays the scroll until the latest DOM
                // mutation has settled — without it, scrollHeight on this
                // tick may not yet reflect the appended chunk.
                queueMicrotask(() => {
                    host.scrollTop = host.scrollHeight;
                });
            }
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
