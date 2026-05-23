import {
    ChangeDetectionStrategy,
    Component,
    inject,
    input,
    output,
    signal,
    viewChild,
} from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MarkdownModule } from 'ngx-markdown';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { TranslatePipe } from '@app/core/i18n';
import { AutoScrollBottomDirective } from '@app/shared/directives/auto-scroll-bottom.directive';
import { AgentLinkInterceptor } from '@app/core/services/agent-hints/agent-link-interceptor.service';
import { AgentHintRegistry } from '@app/core/services/agent-hints/agent-hints.registry';
import type { AgentLogEntry } from '@app/core/services/agent-runner/agent-runner.types';

/** The fold-toggle keys carried on `AgentLogEntry` — view click handlers flip these. */
export type AgentLogFoldKey = 'isThoughtCollapsed' | 'isToolCallCollapsed' | 'isToolResultCollapsed';

/** Live "agent is working" indicator state. Pass `null` when the agent is idle. */
export interface AgentRunningIndicator {
    /** Renders the "awaiting user approval" branch (icon + label) instead of the spinner. */
    awaitingApproval?: boolean;
    /** 0-1 prefill / prompt-processing progress. Shown as `Processing prompt: N%` when present and < 1. */
    promptProgress?: number;
    /** Cumulative model-emitted token count for the current turn. Shown when > 0 and no PP is in flight. */
    tokenCount?: number;
    /** Cumulative model-emitted chunk count for the current turn. Shown when tokens aren't being tracked (chunk fallback). */
    chunkCount?: number;
}

/**
 * Pure render surface for an agent's structured log trace — extracted from
 * {@link import('../agent-console/agent-console.component').AgentConsoleComponent}
 * so multi-agent-save's progress dialog (and any future agent surface) can
 * show the same rich card layout instead of a flat text blob.
 *
 * Owns: scroll viewport (with auto-follow + floating snap-back button),
 * per-entry rendering (thought / tool-call / tool-result folds, markdown +
 * `app://` link interception), and the running-indicator row.
 *
 * Does NOT own: agent input bar, profile picker, context-usage bar, copy-debug
 * button. Those stay in AgentConsole — they couple to the live FileAgentService
 * and have no reuse story in the save dialog.
 */
@Component({
    selector: 'app-agent-trace-surface',
    standalone: true,
    imports: [
        ...CORE_MAT,
        MatProgressSpinnerModule,
        NgClass,
        DecimalPipe,
        MarkdownModule,
        TranslatePipe,
        AutoScrollBottomDirective,
    ],
    templateUrl: './agent-trace-surface.component.html',
    styleUrl: './agent-trace-surface.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AgentTraceSurfaceComponent {
    logs = input.required<readonly AgentLogEntry[]>();
    /** Pass `null` when the agent is idle — omits the indicator row. */
    indicator = input<AgentRunningIndicator | null>(null);
    /** When false, the floating "snap to bottom" button never shows even if the user scrolls up. SaveProgressDialog disables it (entries live inside a constrained expansion panel). */
    showScrollToBottomButton = input(true);

    /**
     * Fold-header click. Parent owns the log array (in AgentConsole it's
     * `FileAgentService.agentLogs`; in the save dialog it's the per-agent
     * signal mirrored via the tracker) so the mutation happens there.
     * Surface is intentionally controlled — same fold state shows on every
     * mounted surface for the same log signal.
     */
    foldToggle = output<{ index: number; key: AgentLogFoldKey }>();

    private linkInterceptor = inject(AgentLinkInterceptor);
    private hintRegistry = inject(AgentHintRegistry);

    /** Memoizes `breadcrumbifyLinks` by source text — same input string ⇒ same output reference, so `<markdown [data]>` doesn't re-parse on every CD. */
    private readonly breadcrumbCache = new WeakMap<AgentLogEntry, { src: string; out: string }>();

    /** Template binds `(atBottom)` to drive the floating button's visibility. */
    protected showScrollButton = signal(false);
    private scroller = viewChild('scroller', { read: AutoScrollBottomDirective });

    protected onFoldClick(index: number, key: AgentLogFoldKey): void {
        this.foldToggle.emit({ index, key });
    }

    /** Floating-button click — explicit user intent, overrides directive's internal sticky state. */
    protected onScrollToBottomClick(): void {
        this.scroller()?.scrollToBottom(false);
    }

    /**
     * Intercept `app://...` links in agent output. Bound on each markdown
     * wrapper via `(click)`. Falls through silently for non-`app://` anchors
     * so external links keep working.
     *
     * Angular's HTML sanitizer doesn't whitelist `app:` as a known-safe scheme
     * (only http/https/mailto/data/ftp/tel/file/sms), so it prefixes the rendered
     * href with `unsafe:` — a selector like `a[href^="app://"]` won't match.
     * Read the raw attribute and strip the prefix instead.
     */
    protected onAgentLogClick(event: MouseEvent): void {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
        if (!anchor) return;
        const raw = anchor.getAttribute('href') ?? '';
        const cleaned = raw.startsWith('unsafe:') ? raw.slice('unsafe:'.length) : raw;
        if (!cleaned.startsWith('app://')) return;
        if (this.linkInterceptor.dispatch(cleaned)) {
            event.preventDefault();
        }
    }

    /**
     * Expand `[anything](app://hint/A/B/C)` into a per-segment clickable chain:
     * `[A](app://hint/A) › [B](app://hint/A/B) › [C](app://hint/A/B/C)`.
     *
     * Two passes:
     *   1. **Collapse manually-composed chains.** LLMs sometimes ignore the
     *      "emit only the deepest" rule and string ancestor links together
     *      with `›` / `>` separators. Each ancestor would then re-expand on
     *      pass 2, producing nested duplicates. Detect adjacent links where
     *      the earlier path is a prefix of the later one and drop the earlier.
     *   2. **Per-segment expansion.** Single deep link → chain of one link per
     *      segment. Trailing query (e.g. `?do=activate`) stays on the LAST
     *      segment only. Top-level entries (no `/`) keep the original markup.
     *
     * Cached per log entry by source-text identity so `<markdown [data]>`
     * doesn't re-parse on every CD.
     */
    protected breadcrumbifyLinks(log: AgentLogEntry): string {
        const src = log.text ?? '';
        const cached = this.breadcrumbCache.get(log);
        if (cached?.src === src) return cached.out;

        let collapsed = src;
        const chainRe = /\[([^\]]+)\]\(app:\/\/hint\/([^)?\s]+)(?:\?[^)]*)?\)(\s*[›»→>]+\s*)\[([^\]]+)\]\(app:\/\/hint\/([^)?\s]+)([^)]*)\)/g;
        for (let pass = 0; pass < 8; pass++) {
            const next = collapsed.replace(chainRe, (whole, _l1, p1: string, _sep, l2: string, p2: string, q2: string) => {
                return (p2 + '/').startsWith(p1 + '/') ? `[${l2}](app://hint/${p2}${q2})` : whole;
            });
            if (next === collapsed) break;
            collapsed = next;
        }

        const out = collapsed.replace(
            /\[([^\]]+)\]\(app:\/\/hint\/([^)?\s]+)([^)]*)\)/g,
            (whole, _label, path: string, query: string) => {
                if (!path.includes('/')) return whole;
                const segments = path.split('/');
                // Bail if ANY segment in the chain isn't a real manifest path — LLM
                // can hallucinate segment ids, and expanding then surfaces raw dict
                // keys like `agentHint.sidebar.new-game.name` as the link text.
                // Keep the LLM's original markup so the click handler can toast a
                // "target not found" instead.
                for (let i = 0; i < segments.length; i++) {
                    const sub = segments.slice(0, i + 1).join('/');
                    if (!this.hintRegistry.findByPath(sub)) return whole;
                }
                return segments.map((_seg, i) => {
                    const sub = segments.slice(0, i + 1).join('/');
                    const name = this.hintRegistry.nameOf(sub);
                    const url = `app://hint/${sub}${i === segments.length - 1 ? query : ''}`;
                    return `[${name}](${url})`;
                }).join(' › ');
            },
        );
        this.breadcrumbCache.set(log, { src, out });
        return out;
    }
}
