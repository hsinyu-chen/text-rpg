import { Component, inject, ElementRef, effect, viewChild, signal, computed, afterNextRender, DestroyRef, ChangeDetectionStrategy, TemplateRef, ViewContainerRef, EmbeddedViewRef } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BreakpointObserver } from '@angular/cdk/layout';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { ChatMessage } from '@app/core/models/types';
import { GAME_INTENTS } from '@app/core/constants/game-intents';
import { ChatMessageComponent } from './components/chat-message/chat-message.component';
import { ChatInputComponent } from './components/chat-input/chat-input.component';
import { TurnUpdatePanelComponent } from './components/turn-update-panel/turn-update-panel.component';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { AgentConsoleComponent } from '@app/shared/components/agent-console/agent-console.component';
import { FileAgentService } from '@app/core/services/file-agent/file-agent.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { BridgeService } from '@app/core/services/dev/bridge.service';
import { AgentMessageJumperService } from '@app/core/services/agent-hints/agent-message-jumper.service';
import { spotlightElement } from '@app/core/services/agent-hints/spotlight.util';
import { AgentPanelStateService } from '@app/core/services/file-agent/agent-panel-state.service';

@Component({
    selector: 'app-chat',
    standalone: true,
    imports: [
        MatButtonModule,
        MatIconModule,
        MatProgressSpinnerModule,
        MatSidenavModule,
        MatTooltipModule,
        ChatMessageComponent,
        ChatInputComponent,
        TurnUpdatePanelComponent,
        AgentConsoleComponent,
        TranslatePipe
    ],
    templateUrl: './chat.component.html',
    styleUrl: './chat.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    // FileAgentService owns the agent log + history signals; provide here so
    // the main-screen agent has its own instance, independent from any file-
    // viewer dialog the user might open simultaneously. KV-backed profile
    // selection (see file-agent.service.ts FILE_AGENT_PROFILE_KEY) keeps the
    // pre-selected profile in sync across instances.
    providers: [FileAgentService]
})
export class ChatComponent {
    engine = inject(GameEngineService);
    state = inject(GameStateService);
    i18n = inject(I18nService);
    appConfig = inject(AppConfigStore);
    private breakpointObserver = inject(BreakpointObserver);
    private destroyRef = inject(DestroyRef);
    private bridge = inject(BridgeService);
    private messageJumper = inject(AgentMessageJumperService);
    protected panelState = inject(AgentPanelStateService);
    private viewContainerRef = inject(ViewContainerRef);
    private doc = inject(DOCUMENT);

    private scrollContainer = viewChild<ElementRef>('scrollContainer');
    private contentWrapper = viewChild<ElementRef<HTMLElement>>('contentWrapper');
    private chatInput = viewChild<ChatInputComponent>('chatInput');
    private agentPanelTpl = viewChild<TemplateRef<unknown>>('agentPanelTpl');
    private agentPanelView: EmbeddedViewRef<unknown> | null = null;
    private agentPanelHost: HTMLDivElement | null = null;
    private agentPipWin: Window | null = null;

    userInput = signal('');
    selectedIntent = signal(GAME_INTENTS.ACTION);
    editingMessageId = signal<string | null>(null);
    showScrollButton = signal(false);
    isSidebarOpen = signal(false);
    isAgentSidebarOpen = signal(false);

    /**
     * Files map passed into <app-agent-console>. Always the engine's live map —
     * writes (when the panel-state edit channel is available) route through
     * the channel to whoever registered (typically file-viewer's Monaco buffer)
     * instead of touching this map.
     */
    agentFiles = computed(() => this.state.loadedFiles());

    isMobile = toSignal(
        this.breakpointObserver.observe('(max-width: 900px)').pipe(map(result => result.matches)),
        { initialValue: false }
    );

    sidenavMode = computed(() => this.isMobile() ? 'over' : 'side');

    private resizeObserver: ResizeObserver | null = null;
    private userScrolledUp = false;
    private lastScrollTop = 0;
    private scrollFrameId: number | null = null;
    private hasInitialScrolled = false;
    private prevLastCotOpen = false;

    /** Bridge-driven fill request forwarded into AgentConsoleComponent; null until the bridge sends one, then tick-versioned payloads. */
    agentConsoleFillRequest = signal<{ prompt: string; autoSend: boolean; tick: number } | null>(null);

    constructor() {
        // Bridge-driven open requests (dev-only). The tick counter increments
        // every agent_open_chat_agent_panel frame; ignore the first tick on
        // mount (initial value 0 → we'd open the panel on every chat load
        // even when the bridge never spoke).
        let lastTick = this.bridge.openChatAgentPanelTick();
        effect(() => {
            const tick = this.bridge.openChatAgentPanelTick();
            if (tick !== lastTick) {
                lastTick = tick;
                this.isAgentSidebarOpen.set(true);
            }
        });

        // Bridge-driven fill: when the bridge pushes a prompt into the chat
        // panel, ensure the panel is open and forward the payload to
        // agent-console. The bridge handler already increments
        // openChatAgentPanelTick, so the open-effect above will fire too;
        // setting here covers the case where the open-tick handler runs
        // before the agent-console has mounted.
        let lastFillPayloadTick = this.bridge.chatPanelPromptFill()?.tick ?? 0;
        effect(() => {
            const fill = this.bridge.chatPanelPromptFill();
            if (!fill || fill.tick === lastFillPayloadTick) return;
            lastFillPayloadTick = fill.tick;
            this.isAgentSidebarOpen.set(true);
            this.agentConsoleFillRequest.set(fill);
        });

        // app://message/<id>[/<action>] link clicked in agent-console →
        // jumper service emits → we drive the existing onJumpToMessage path,
        // optionally spotlighting a specific toolbar action button.
        let lastJumpTick = this.messageJumper.request()?.tick ?? 0;
        effect(() => {
            const req = this.messageJumper.request();
            if (!req || req.tick === lastJumpTick) return;
            lastJumpTick = req.tick;
            this.onJumpToMessage(req.id, req.action);
        });

        // Initial load: force scroll to bottom the first time messages appear,
        // bypassing the smartScroll threshold that would otherwise treat scrollTop=0 as "user scrolled up".
        effect(() => {
            const count = this.state.messages().length;
            if (count > 0 && !this.hasInitialScrolled && this.scrollContainer()) {
                this.hasInitialScrolled = true;
                // Wait two frames so content-visibility elements have a chance to be laid out
                // before we measure scrollHeight; scheduleScrollCorrection handles the rest.
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        this.scrollToBottom(true);
                    });
                });
            }
        });

        // Init/Loading Jump Effect
        effect(() => {
            const status = this.state.status();
            // When going to idle or generating (and not scrolled up), ensure we are at bottom.
            if ((status === 'idle' || status === 'generating') && !this.userScrolledUp) {
                // We use a small timeout to allow new elements to render before scrolling
                setTimeout(() => {
                    this.scrollToBottom(true);
                }, 50);
            }
        });

        // CoT panel re-opens (e.g. two-call narrator phase) expand the last
        // message's height enough to push distFromBottom past the smartScroll
        // threshold, breaking auto-follow. Re-pin to bottom once on the
        // false→true edge so streaming chunks resume following.
        // Wrap the value in a computed so the effect doesn't re-run on every
        // streaming chunk — only when cotOpen on the last message flips.
        const lastCotOpen = computed(() => {
            const msgs = this.state.messages();
            const last = msgs[msgs.length - 1];
            return last?.role === 'model' ? (last.cotOpen ?? false) : false;
        });
        effect(() => {
            const cot = lastCotOpen();
            const wasOpen = this.prevLastCotOpen;
            this.prevLastCotOpen = cot;
            if (cot && !wasOpen && this.state.status() === 'generating' && !this.userScrolledUp) {
                requestAnimationFrame(() => this.scrollToBottom(true));
            }
        });

        afterNextRender(() => {
            this.initScrollObservers();
        });

        // Manually portal the agent panel into <body>. We tried CDK Overlay
        // first but CDK 19+ defaults to the native popover API: wrappers carry
        // `popover="manual"` and render into the browser top-layer, which
        // IGNORES z-index — ordering is purely "last-shown wins". Any dialog
        // opened after the agent panel paints over it. A plain body-level
        // <div> with z-index 1100 lives in normal stacking order, above
        // cdk-overlay-container (z:1000).
        effect(() => {
            const open = this.isAgentSidebarOpen();
            if (open) this.mountAgentPanel();
            else this.unmountAgentPanel();
        });

        this.destroyRef.onDestroy(() => {
            this.resizeObserver?.disconnect();
            if (this.scrollFrameId) {
                cancelAnimationFrame(this.scrollFrameId);
            }
            this.unmountAgentPanel();
        });
    }

    // Generation token: every mount/unmount bumps this. Async PiP open
    // (`requestWindow` awaits a user gesture / permission grant) checks the
    // token after resume; if it changed (panel was closed during the await),
    // the open path aborts cleanly instead of attaching a zombie window.
    private mountGeneration = 0;

    private mountAgentPanel(): void {
        if (this.agentPanelView || this.agentPipWin) return;
        const tpl = this.agentPanelTpl();
        if (!tpl) return;
        const gen = ++this.mountGeneration;
        this.agentPanelView = this.viewContainerRef.createEmbeddedView(tpl);
        this.agentPanelView.detectChanges();
        const rootNodes = this.agentPanelView.rootNodes as Node[];

        // Prefer the native Document Picture-in-Picture API when available
        // (Chrome 116+). It opens the agent panel in a separate browser
        // window — no top-layer fighting with main-app dialogs/menus, and
        // the agent's own dropdowns just work because the PiP window has
        // its own top-layer scope. Falls back to body-portal + popover on
        // browsers that don't support it (Firefox / Safari today).
        const pipApi = (this.doc.defaultView as Window & {
            documentPictureInPicture?: { requestWindow: (opts: { width?: number; height?: number }) => Promise<Window> };
        } | null)?.documentPictureInPicture;
        if (pipApi) {
            void this.openInPip(pipApi, rootNodes, gen);
        } else {
            this.openInBodyPortal(rootNodes);
        }
    }

    private async openInPip(
        api: { requestWindow: (opts: { width?: number; height?: number }) => Promise<Window> },
        rootNodes: Node[],
        gen: number,
    ): Promise<void> {
        let pipWin: Window;
        try {
            pipWin = await api.requestWindow({ width: 480, height: 720 });
        } catch {
            // user denied / call rejected (e.g. no user gesture) — fall back,
            // but only if the user hasn't already closed the panel mid-await.
            if (gen !== this.mountGeneration) return;
            this.openInBodyPortal(rootNodes);
            return;
        }
        // Panel was closed (and view destroyed) during the requestWindow await.
        // Discard the now-stale window instead of attaching detached DOM to it.
        if (gen !== this.mountGeneration) {
            try { pipWin.close(); } catch { /* already closed */ }
            return;
        }
        // Copy stylesheets so Material / app styles take effect in the PiP doc.
        // Same JS realm, so signals + change detection keep flowing across.
        for (const node of Array.from(this.doc.head.querySelectorAll('link[rel="stylesheet"], style'))) {
            pipWin.document.head.appendChild(node.cloneNode(true));
        }
        pipWin.document.body.style.margin = '0';
        pipWin.document.body.style.height = '100vh';
        pipWin.document.body.style.overflow = 'hidden';
        // Mark the body so the shell stretches edge-to-edge inside the PiP
        // window instead of its default min(480px, 92vw) which leaves gutters
        // when the user resizes the PiP smaller than 480px.
        pipWin.document.body.classList.add('agent-panel-pip');
        for (const n of rootNodes) pipWin.document.body.appendChild(n);
        this.agentPipWin = pipWin;
        // Expose the PiP doc to PipAwareOverlayContainer (provided at
        // agent-console scope) so matTooltip / mat-menu / mat-dialog
        // overlays opened inside the panel land in the PiP window instead
        // of the main one.
        this.panelState.pipDocument.set(pipWin.document);
        // Flag so file-viewer hides its own smart_toy button while PiP is up
        // (otherwise we'd have two agent UIs racing). Edit routing is handled
        // separately via panelState.editChannel — registered by whichever
        // surface owns an unsaved-buffer (file-viewer's Monaco).
        this.panelState.pipActive.set(true);
        // User closes the PiP window via OS chrome — sync state back.
        pipWin.addEventListener('pagehide', () => {
            if (this.agentPipWin === pipWin) {
                this.agentPipWin = null;
                this.panelState.pipDocument.set(null);
                this.isAgentSidebarOpen.set(false);
            }
        });
    }

    private openInBodyPortal(rootNodes: Node[]): void {
        if (!this.agentPanelHost) {
            this.agentPanelHost = this.doc.createElement('div');
            this.agentPanelHost.className = 'agent-panel-host';
            // popover="manual" puts us in the browser top-layer alongside
            // every cdk-overlay dialog (CDK 19+ uses the same API). Within
            // top-layer z-index is ignored; ordering is purely "last shown
            // wins", so we re-promote ourselves whenever a sibling popover
            // opens, unless the click that triggered it came from inside
            // the panel (own dropdown / menu) — see installAgentPanelPromoter.
            this.agentPanelHost.setAttribute('popover', 'manual');
            this.doc.body.appendChild(this.agentPanelHost);
        }
        for (const node of rootNodes) {
            this.agentPanelHost.appendChild(node);
        }
        try { this.agentPanelHost.showPopover(); } catch { /* not connected / no support */ }
        this.installAgentPanelPromoter();
    }

    private unmountAgentPanel(): void {
        // Invalidate any in-flight openInPip awaiting requestWindow.
        this.mountGeneration++;
        this.uninstallAgentPanelPromoter();
        this.panelState.pipActive.set(false);
        this.panelState.pipDocument.set(null);
        if (this.agentPipWin) {
            try { this.agentPipWin.close(); } catch { /* already closed */ }
            this.agentPipWin = null;
        }
        if (this.agentPanelHost?.matches(':popover-open')) {
            try { this.agentPanelHost.hidePopover(); } catch { /* race */ }
        }
        if (this.agentPanelView) {
            this.agentPanelView.destroy();
            this.agentPanelView = null;
        }
        if (this.agentPanelHost) {
            this.agentPanelHost.remove();
            this.agentPanelHost = null;
        }
    }

    private agentPanelPromoter: ((e: Event) => void) | null = null;
    private agentPanelClickTracker: ((e: Event) => void) | null = null;
    private agentPanelLastOwnClickAt = 0;

    private installAgentPanelPromoter(): void {
        if (this.agentPanelPromoter) return;
        // Whenever ANY other popover opens (Material dialogs use the same
        // popover API since CDK 19), we re-show ours to bring it back to
        // the top of the top-layer — UNLESS the popover that just opened
        // is our own descendant (mat-select / mat-menu triggered from a
        // click inside the panel). Detected temporally: a click inside the
        // panel within the last 400ms marks any subsequent popover-open as
        // "ours". Without this guard the panel covers its own dropdowns.
        this.agentPanelClickTracker = (e: Event) => {
            if (this.agentPanelHost?.contains(e.target as Node)) {
                this.agentPanelLastOwnClickAt = Date.now();
            }
        };
        this.doc.addEventListener('click', this.agentPanelClickTracker, true);

        this.agentPanelPromoter = (e: Event) => {
            const target = e.target as HTMLElement;
            if (!this.agentPanelHost || target === this.agentPanelHost) return;
            const toggle = e as ToggleEvent;
            if (toggle.newState !== 'open') return;
            // Skip re-promote when the just-opened popover is likely ours.
            if (Date.now() - this.agentPanelLastOwnClickAt < 400) return;
            queueMicrotask(() => {
                const host = this.agentPanelHost;
                if (!host || !host.matches(':popover-open')) return;
                try { host.hidePopover(); host.showPopover(); } catch { /* race */ }
            });
        };
        this.doc.addEventListener('toggle', this.agentPanelPromoter, true);
    }

    private uninstallAgentPanelPromoter(): void {
        if (this.agentPanelPromoter) {
            this.doc.removeEventListener('toggle', this.agentPanelPromoter, true);
            this.agentPanelPromoter = null;
        }
        if (this.agentPanelClickTracker) {
            this.doc.removeEventListener('click', this.agentPanelClickTracker, true);
            this.agentPanelClickTracker = null;
        }
    }

    private initScrollObservers() {
        const scrollEl = this.scrollContainer()?.nativeElement;
        const contentEl = this.contentWrapper()?.nativeElement;

        if (!scrollEl || !contentEl) return;

        scrollEl.addEventListener('scroll', () => {
            this.checkScroll(scrollEl);
        }, { passive: true });

        this.resizeObserver = new ResizeObserver(() => {
            this.smartScroll();
        });
        this.resizeObserver.observe(contentEl);
    }

    checkScroll(el: HTMLElement) {
        // Run light check logic
        const threshold = 300;
        const currentScrollTop = el.scrollTop;
        const distFromBottom = el.scrollHeight - currentScrollTop - el.clientHeight;

        const show = distFromBottom > threshold;

        // Detect user intent (scrolling up vs down)
        if (distFromBottom < 50) {
            this.userScrolledUp = false;
        } else if (currentScrollTop < this.lastScrollTop - 5) {
            this.userScrolledUp = true;
        }

        this.lastScrollTop = currentScrollTop;

        // Update signal only if changed
        if (this.showScrollButton() !== show) {
            this.showScrollButton.set(show);
        }
    }

    private smartScroll() {
        // Debounce with RAF to avoid thrashing if multiple resize events fire
        if (this.scrollFrameId) {
            cancelAnimationFrame(this.scrollFrameId);
        }

        this.scrollFrameId = requestAnimationFrame(() => {
            this.scrollFrameId = null;
            this.performSmartScroll();
        });
    }

    private performSmartScroll() {
        const scrollRef = this.scrollContainer();
        if (!scrollRef) return;
        const el = scrollRef.nativeElement;

        // Logic: specific thresholds for when to auto-scroll
        const isGenerating = this.state.status() === 'generating';

        // If content is smaller than view, nothing to do
        if (el.scrollHeight <= el.clientHeight) return;

        // More generous threshold during generation
        const threshold = isGenerating ? 800 : 400;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;

        const shouldFollow = dist < threshold && !this.userScrolledUp;

        if (shouldFollow) {
            // Instant scroll if very close or generating to keep up with stream
            const forceInstant = isGenerating || dist < 100;
            this.scrollToBottom(forceInstant);
        }
    }

    scrollToBottom(force = false): void {
        const scrollRef = this.scrollContainer();
        if (!scrollRef) return;

        const el = scrollRef.nativeElement;
        try {
            if (force) {
                // Direct assignment relies on CSS scroll-behavior NOT being smooth (we removed it),
                // otherwise this animates and gets misdetected as user scroll mid-flight.
                el.scrollTop = el.scrollHeight;
                this.userScrolledUp = false;
            } else {
                el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }

            // content-visibility elements get revealed during the scroll, growing scrollHeight.
            // Keep re-pinning to the bottom until distance settles (or we hit the safety cap).
            this.scheduleScrollCorrection(el, force);
        } catch { /* ignore */ }
    }

    private scheduleScrollCorrection(el: HTMLElement, force: boolean, attempt = 0, lastHeight = -1): void {
        if (attempt >= 30) return;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (this.userScrolledUp) return;
                const currHeight = el.scrollHeight;
                const dist = currHeight - el.scrollTop - el.clientHeight;
                if (dist <= 1) return;

                // Layout has stabilised but we're still short — further retries won't help.
                if (currHeight === lastHeight) return;

                if (force) {
                    el.scrollTop = currHeight;
                } else {
                    el.scrollTo({ top: currHeight, behavior: 'auto' });
                }
                this.scheduleScrollCorrection(el, force, attempt + 1, currHeight);
            });
        });
    }

    onEditAndResend(msg: ChatMessage) {
        this.editingMessageId.set(msg.id);
        const intent = msg.intent || GAME_INTENTS.ACTION;
        const content = msg.content.replace(/^<[^>]+>/, '').trim();
        this.chatInput()?.startEdit(intent, content, msg.userIdealOutcome);
    }

    isLastUserMessage(id: string): boolean {
        const messages = this.state.messages();
        let lastUser: ChatMessage | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                lastUser = messages[i];
                break;
            }
        }
        return id === lastUser?.id;
    }

    toggleSidebar() {
        this.isSidebarOpen.update(v => !v);
    }

    toggleAgentSidebar() {
        this.isAgentSidebarOpen.update(v => !v);
    }

    // Tracks the active `.msg-toolbar-pinned` clear timer per message
    // wrapper so two rapid action-link clicks on different messages don't
    // race — the first click's clear timer was wiping the second click's
    // pinned class mid-spotlight.
    private toolbarPinnedTimers = new WeakMap<HTMLElement, number>();

    onJumpToMessage(id: string, action: string | null = null) {
        setTimeout(() => {
            const root = this.contentWrapper()?.nativeElement;
            const el = root?.querySelector<HTMLElement>(`#message-${CSS.escape(id)}`);
            if (!el) return;
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (action) {
                // Toolbar buttons are hidden until hover; force-show the
                // toolbar for the spotlight duration so the user can both
                // see and click the highlighted target.
                const btn = el.querySelector<HTMLElement>(`[data-msg-action="${CSS.escape(action)}"]`);
                if (btn) {
                    el.classList.add('msg-toolbar-pinned');
                    const prev = this.toolbarPinnedTimers.get(el);
                    if (prev !== undefined) clearTimeout(prev);
                    // Wait for the smooth scroll to settle before measuring
                    // the bbox — matches the 250ms registry uses for hint
                    // spotlights.
                    setTimeout(() => spotlightElement(btn), 250);
                    const timer = setTimeout(() => {
                        el.classList.remove('msg-toolbar-pinned');
                        this.toolbarPinnedTimers.delete(el);
                    }, 2400) as unknown as number;
                    this.toolbarPinnedTimers.set(el, timer);
                    return;
                }
                // Action segment named but no matching button on this
                // message (e.g. user-msg / non-save model-msg with
                // auto-update link): fall through to message-level flash.
            }
            el.classList.add('highlight-flash');
            setTimeout(() => el.classList.remove('highlight-flash'), 2000);
        }, 50);
    }
}
