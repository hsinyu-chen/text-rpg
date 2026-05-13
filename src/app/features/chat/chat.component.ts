import { Component, inject, ElementRef, effect, viewChild, signal, computed, afterNextRender, DestroyRef, ChangeDetectionStrategy, TemplateRef, ViewContainerRef } from '@angular/core';
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
import { spotlightElement, SPOTLIGHT_HOLD_MS } from '@app/core/services/agent-hints/spotlight.util';
import { AgentPanelPortalService } from '@app/shared/components/agent-console/agent-panel-portal.service';
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
    providers: [FileAgentService, AgentPanelPortalService]
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
    private agentPanelPortal = inject(AgentPanelPortalService);

    private scrollContainer = viewChild<ElementRef>('scrollContainer');
    private contentWrapper = viewChild<ElementRef<HTMLElement>>('contentWrapper');
    private chatInput = viewChild<ChatInputComponent>('chatInput');
    private agentPanelTpl = viewChild<TemplateRef<unknown>>('agentPanelTpl');

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
    // While true, every bottom-pinning path (status-change effect,
    // smartScroll, scheduleScrollCorrection, scrollToBottom callers) is
    // suppressed. `userScrolledUp` alone wasn't enough because
    // scrollToBottom() resets it to false — so a status-change effect's
    // queued setTimeout, firing 50ms after agent-done, would undo the
    // jump's userScrolledUp=true. The flag is set sync on jump start and
    // cleared after the scroll + spotlight settle.
    private jumpInProgress = false;
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
                    if (this.jumpInProgress) return;
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
                requestAnimationFrame(() => {
                    if (this.jumpInProgress) return;
                    this.scrollToBottom(true);
                });
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
            const tpl = this.agentPanelTpl();
            if (open && tpl) {
                this.agentPanelPortal.mount(tpl, this.viewContainerRef, {
                    onPipClosed: () => this.isAgentSidebarOpen.set(false),
                });
            } else {
                this.agentPanelPortal.unmount();
            }
        });

        this.destroyRef.onDestroy(() => {
            this.resizeObserver?.disconnect();
            if (this.scrollFrameId) {
                cancelAnimationFrame(this.scrollFrameId);
            }
            this.agentPanelPortal.unmount();
        });
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
        if (this.jumpInProgress) return;
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

    // User-initiated scroll-to-bottom (floating button). Cancels any
    // active deep-link jump guard — user explicitly asking for bottom
    // beats a still-running jump's stay-pinned protection.
    onScrollToBottomClick(): void {
        this.jumpInProgress = false;
        this.scrollToBottom(false);
    }

    scrollToBottom(force = false): void {
        if (this.jumpInProgress) return;
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
                if (this.userScrolledUp || this.jumpInProgress) return;
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

    // Spotlight scroll delay — registry uses the same value for hint
    // targets. Add a small post-hold buffer so the unpin doesn't strip
    // .msg-toolbar-pinned mid-fade.
    private static readonly SPOTLIGHT_SCROLL_DELAY_MS = 250;
    private static readonly TOOLBAR_PIN_HOLD_MS = ChatComponent.SPOTLIGHT_SCROLL_DELAY_MS + SPOTLIGHT_HOLD_MS + 50;
    // setTimeout before scroll — gives Angular's queued change-detection one
    // tick to materialize any just-rendered messages before we measure offsets
    // or query for #message-<id>.
    private static readonly JUMP_TO_MESSAGE_DELAY_MS = 50;
    // How long to keep the inline `content-visibility: visible` override on
    // a jumped-to message. Long enough to cover the smooth-scroll animation
    // (~300-500ms) PLUS the spotlight hold (~2.1s) so layout doesn't re-skip
    // mid-animation. Restored to the previous inline value once elapsed.
    private static readonly CV_OVERRIDE_HOLD_MS = 3000;

    // Per-message-wrapper timer bookkeeping so rapid action-link clicks on
    // different messages don't race-strip each other's pinned class /
    // double-spotlight.
    private toolbarPinnedTimers = new WeakMap<HTMLElement, number>();
    private spotlightTimers = new WeakMap<HTMLElement, number>();

    onJumpToMessage(id: string, action: string | null = null) {
        // Set BOTH guards sync at click time, not inside the setTimeout below.
        // - userScrolledUp: semantically correct (we're leaving the bottom)
        //   and stops in-flight scheduleScrollCorrection rAF loops.
        // - jumpInProgress: catches the cases userScrolledUp alone can't —
        //   scrollToBottom() resets userScrolledUp=false, so any queued
        //   bottom-pin (status-change effect's setTimeout(50), ResizeObserver
        //   triggered by our cv override) would undo the flag. jumpInProgress
        //   is one-way until we explicitly clear it post-scroll.
        this.userScrolledUp = true;
        this.jumpInProgress = true;
        setTimeout(() => { this.jumpInProgress = false; }, ChatComponent.CV_OVERRIDE_HOLD_MS);
        setTimeout(() => {
            const root = this.contentWrapper()?.nativeElement;
            const scrollEl = this.scrollContainer()?.nativeElement as HTMLElement | undefined;
            const el = root?.querySelector<HTMLElement>(`#message-${CSS.escape(id)}`);
            if (!el || !scrollEl) return;
            const prevCv = el.style.contentVisibility;
            el.style.contentVisibility = 'visible';
            void el.offsetHeight;
            // Compute target scrollTop manually. scrollIntoView({behavior:'smooth'})
            // silently no-ops when the target is far from the current viewport
            // AND there are content-visibility:auto elements between current
            // scrollTop and target — Chrome bails on the layout chain it can't
            // resolve cheaply. scrollEl.scrollTo with an explicit numeric
            // target sidesteps that algorithm.
            const containerRect = scrollEl.getBoundingClientRect();
            const elRect = el.getBoundingClientRect();
            const targetContentTop = scrollEl.scrollTop + (elRect.top - containerRect.top);
            const centeredTop = targetContentTop - (scrollEl.clientHeight - elRect.height) / 2;
            const clamped = Math.max(0, Math.min(centeredTop, scrollEl.scrollHeight - scrollEl.clientHeight));
            scrollEl.scrollTo({ top: clamped, behavior: 'smooth' });
            setTimeout(() => { el.style.contentVisibility = prevCv; }, ChatComponent.CV_OVERRIDE_HOLD_MS);
            if (action) {
                // Toolbar buttons are hidden until hover; force-show the
                // toolbar for the spotlight duration so the user can both
                // see and click the highlighted target.
                const btn = el.querySelector<HTMLElement>(`[data-msg-action="${CSS.escape(action)}"]`);
                if (btn) {
                    el.classList.add('msg-toolbar-pinned');
                    const prevPin = this.toolbarPinnedTimers.get(el);
                    if (prevPin !== undefined) clearTimeout(prevPin);
                    const prevSpot = this.spotlightTimers.get(el);
                    if (prevSpot !== undefined) clearTimeout(prevSpot);
                    const spotTimer = setTimeout(() => {
                        spotlightElement(btn);
                        this.spotlightTimers.delete(el);
                    }, ChatComponent.SPOTLIGHT_SCROLL_DELAY_MS) as unknown as number;
                    this.spotlightTimers.set(el, spotTimer);
                    const pinTimer = setTimeout(() => {
                        el.classList.remove('msg-toolbar-pinned');
                        this.toolbarPinnedTimers.delete(el);
                    }, ChatComponent.TOOLBAR_PIN_HOLD_MS) as unknown as number;
                    this.toolbarPinnedTimers.set(el, pinTimer);
                    return;
                }
                // Action segment named but no matching button on this
                // message (e.g. user-msg / non-save model-msg with
                // auto-update link): fall through to message-level flash.
            }
            el.classList.add('highlight-flash');
            setTimeout(() => el.classList.remove('highlight-flash'), 2000);
        }, ChatComponent.JUMP_TO_MESSAGE_DELAY_MS);
    }
}
