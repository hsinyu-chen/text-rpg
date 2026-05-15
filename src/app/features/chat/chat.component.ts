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
    // AgentPanelPortalService is component-scoped because each chat surface
    // owns its own embedded slot + PiP lifecycle. FileAgentService is now a
    // root singleton — every surface (chat, file-viewer createWorldMode,
    // headless bridge agent_ask) reads from the SAME agent state, so
    // closing the panel mid-run never drops history / logs / FSM state.
    providers: [AgentPanelPortalService]
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
    // Reflects panelState.isOpen — local alias kept for template bindings
    // (chat-input close button etc.) that already read it through this name.
    isAgentSidebarOpen = this.panelState.isOpen;

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
    // cleared after the scroll + spotlight settle. jumpTimeoutId tracks
    // the clear timer so rapid successive jumps reset the window rather
    // than fighting each other (jump #1's timer firing during jump #2's
    // hold would shrink the protection window).
    private jumpInProgress = false;
    private jumpTimeoutId: ReturnType<typeof setTimeout> | null = null;
    private lastScrollTop = 0;
    private scrollFrameId: number | null = null;
    private hasInitialScrolled = false;
    private prevLastCotOpen = false;

    /** Forwarded directly from AgentPanelStateService.fillRequest — chat-side
     *  agent-console reads via input. The signal already encodes "panel open"
     *  semantics (panelState.pushFillRequest flips isOpen), so no per-source
     *  effect wiring is needed; AgentConsoleComponent dedupes by tick. */
    agentConsoleFillRequest = this.panelState.fillRequest;

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

        // Drive the agent-panel portal off two signals:
        //   isOpen — user-controlled open/close
        //   preferredMode — pip vs embedded preference (persisted)
        // The embedded slot is always rendered in AppComponent (no @if);
        // EmbeddedAgentSlotService publishes its ViewContainerRef on init,
        // so we don't need a third trigger.
        //
        // The portal's mount() is idempotent in the same mode and tears
        // down the other surface on mode change, so a single effect is
        // enough — no manual previous-mode bookkeeping here.
        effect(() => {
            const open = this.panelState.isOpen();
            const tpl = this.agentPanelTpl();
            // Read preferredMode so the effect re-runs on PIP <-> embedded
            // swaps and mount() picks up the new mode.
            this.panelState.preferredMode();
            if (open && tpl) {
                this.agentPanelPortal.mount(tpl, this.viewContainerRef, {
                    // PiP-side close from the browser chrome — the portal
                    // service teases apart back-to-tab vs close X via the
                    // main-window focus heuristic (see PipCloseReason in
                    // agent-panel-portal.service.ts). back-to-tab docks back
                    // into the page; close X drops the panel entirely.
                    onPipClosed: (reason) => {
                        if (reason === 'back-to-tab') {
                            this.panelState.setPreferredMode('embedded');
                        } else {
                            this.panelState.isOpen.set(false);
                        }
                    },
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
        if (this.jumpTimeoutId !== null) {
            clearTimeout(this.jumpTimeoutId);
            this.jumpTimeoutId = null;
        }
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

    /** Template-readable flag for whether the runtime exposes the Document
     *  Picture-in-Picture API — gates the "pop out" button in the embedded
     *  header. */
    isPipSupported(): boolean {
        return this.agentPanelPortal.isPipSupported();
    }

    /** Persist the user's preferred surface and let the portal effect swap
     *  modes on the next tick. The state service writes through to KVStore so
     *  the choice survives reloads. */
    switchAgentPanelTo(mode: 'pip' | 'embedded'): void {
        this.panelState.setPreferredMode(mode);
    }

    // Hard cap on stabilization — cv:auto cascades can shift layout multiple
    // times during a single long jump. 4 s absorbs worst-case and still
    // surfaces eventually rather than hanging silently.
    private static readonly SCROLL_STABILIZE_MAX_MS = 4000;
    private static readonly TOOLBAR_PIN_HOLD_MS = ChatComponent.SCROLL_STABILIZE_MAX_MS + SPOTLIGHT_HOLD_MS + 50;
    // Delay between revealing the target and measuring it — one CD tick so
    // the cv:visible class lands before #message-<id> bbox is read.
    private static readonly JUMP_TO_MESSAGE_DELAY_MS = 50;
    // Breathing room between viewport top and message top — keeps the
    // toolbar comfortably off the edge.
    private static readonly JUMP_TOP_PADDING_PX = 16;
    // Override window for [class.cv-revealed] and the `jumpInProgress`
    // guard. Must outlast stabilization + spotlight hold so the message
    // never re-collapses (cv:auto would re-skip) and competing scroll
    // paths (smartScroll, ResizeObserver bottom-pin) stay suppressed
    // until the jump UX is fully done.
    private static readonly CV_OVERRIDE_HOLD_MS = ChatComponent.SCROLL_STABILIZE_MAX_MS + SPOTLIGHT_HOLD_MS + 50;
    // Matches the `flash` keyframe duration in chat.component.scss.
    private static readonly FLASH_HOLD_MS = 2000;

    // Signal-driven jump state. Template binds [class.msg-toolbar-pinned] /
    // [class.highlight-flash] / [class.cv-revealed] in the @for, so no
    // imperative classList writes. Single timer ref per concern — a rapid
    // second jump clears the previous timer so it can't strip new state.
    pinnedMessageId = signal<string | null>(null);
    flashMessageId = signal<string | null>(null);
    revealedMessageId = signal<string | null>(null);
    private pinTimerId: number | null = null;
    private flashTimerId: number | null = null;
    private cvTimerId: number | null = null;
    private spotlightTimerId: number | null = null;
    private spotlightRetargetTimerId: number | null = null;
    // Aborts the previous stabilizeScroll call's listeners + handlers when
    // a new jump starts. Without this, a rapid second jump leaves the
    // first call's scrollend / wheel / touchstart / keydown listeners
    // attached, so the first call's onStable fires on the wrong (now-
    // stale) message id and stacks listeners on the scroll container.
    private stabilizeAbort: AbortController | null = null;

    private findMessageElement(id: string): HTMLElement | null {
        const root = this.contentWrapper()?.nativeElement;
        return root?.querySelector<HTMLElement>(`#message-${CSS.escape(id)}`) ?? null;
    }

    private revealMessage(id: string): void {
        this.revealedMessageId.set(id);
        if (this.cvTimerId !== null) clearTimeout(this.cvTimerId);
        this.cvTimerId = setTimeout(() => {
            if (this.revealedMessageId() === id) this.revealedMessageId.set(null);
            this.cvTimerId = null;
        }, ChatComponent.CV_OVERRIDE_HOLD_MS) as unknown as number;
    }

    private pinToolbar(id: string): void {
        this.pinnedMessageId.set(id);
        if (this.pinTimerId !== null) clearTimeout(this.pinTimerId);
        this.pinTimerId = setTimeout(() => {
            if (this.pinnedMessageId() === id) this.pinnedMessageId.set(null);
            this.pinTimerId = null;
        }, ChatComponent.TOOLBAR_PIN_HOLD_MS) as unknown as number;
    }

    private flashMessage(id: string): void {
        this.flashMessageId.set(id);
        if (this.flashTimerId !== null) clearTimeout(this.flashTimerId);
        this.flashTimerId = setTimeout(() => {
            if (this.flashMessageId() === id) this.flashMessageId.set(null);
            this.flashTimerId = null;
        }, ChatComponent.FLASH_HOLD_MS) as unknown as number;
    }

    /**
     * Smoothly home in on the target message and fire `onStable` once it
     * settles within tolerance of the desired top-aligned position.
     *
     * Smooth scroll runs continuously: a poll re-aims with a fresh
     * `scrollTo({ behavior: 'smooth' })` whenever cv:auto reveals shift
     * the target past STABLE_BAND_PX. Browser interpolates from current
     * position to new target — no instant jump, no killed animation.
     * Poll stops once drift settles within the band; scrollend then fires
     * and the handler does one last smooth pass if any drift remains.
     *
     * `wheel` / `touchstart` / `keydown` aborts: user is driving now.
     * Hard timeout fires anyway so a never-converging layout surfaces.
     */
    private stabilizeScroll(
        scrollEl: HTMLElement,
        messageEl: HTMLElement,
        onStable: () => void
    ): void {
        // Abort any in-flight stabilization from a previous jump. This
        // clears its listeners + timers in one shot so the stale call's
        // scrollend / wheel handlers can't fire onStable on the wrong id.
        this.stabilizeAbort?.abort();
        const abortCtrl = new AbortController();
        this.stabilizeAbort = abortCtrl;
        const { signal } = abortCtrl;
        if (this.spotlightTimerId !== null) clearTimeout(this.spotlightTimerId);
        if (this.spotlightRetargetTimerId !== null) clearTimeout(this.spotlightRetargetTimerId);
        const TOLERANCE_PX = 4;
        // Anti-jitter: when the freshly computed target sits within this
        // band of the last issued target, the layout has effectively
        // stabilized and we stop re-aiming. The in-flight smooth scroll
        // finishes naturally, scrollend fires, the on-scrollend handler
        // does one last smooth pass if any drift remains.
        const STABLE_BAND_PX = 8;
        const RETARGET_INTERVAL_MS = 100;
        let fired = false;
        let lastTarget = -1;
        const computeDesiredScrollTop = (): number => {
            const containerRect = scrollEl.getBoundingClientRect();
            const elRect = messageEl.getBoundingClientRect();
            const raw = scrollEl.scrollTop + (elRect.top - containerRect.top) - ChatComponent.JUMP_TOP_PADDING_PX;
            return Math.max(0, Math.min(raw, scrollEl.scrollHeight - scrollEl.clientHeight));
        };
        const smoothTo = (target: number): void => {
            lastTarget = target;
            scrollEl.scrollTo({ top: target, behavior: 'smooth' });
        };
        const cleanup = (): void => {
            if (this.spotlightTimerId !== null) {
                clearTimeout(this.spotlightTimerId);
                this.spotlightTimerId = null;
            }
            if (this.spotlightRetargetTimerId !== null) {
                clearTimeout(this.spotlightRetargetTimerId);
                this.spotlightRetargetTimerId = null;
            }
            abortCtrl.abort();
            if (this.stabilizeAbort === abortCtrl) this.stabilizeAbort = null;
        };
        const fire = (): void => {
            if (fired || signal.aborted) return;
            fired = true;
            cleanup();
            onStable();
        };
        const onUserAbort = (): void => {
            if (fired || signal.aborted) return;
            cleanup();
        };
        const onScrollEnd = (): void => {
            if (fired || signal.aborted) return;
            const desired = computeDesiredScrollTop();
            const delta = desired - scrollEl.scrollTop;
            if (Math.abs(delta) <= TOLERANCE_PX) {
                fire();
                return;
            }
            // Settled off-target (last-pixel cv:auto drift). One more
            // smooth pass; re-attach scrollend for the new animation.
            scrollEl.addEventListener('scrollend', onScrollEnd, { once: true, signal });
            smoothTo(desired);
        };
        const MAX_RETARGETS = 4;
        let retargetCount = 0;
        const retargetTick = (): void => {
            if (fired || signal.aborted) return;
            const desired = computeDesiredScrollTop();
            const drift = Math.abs(desired - lastTarget);
            // Drift within the stable band → target has settled. Stop
            // polling so the in-flight smooth scroll can finish and
            // scrollend can fire. Same exit on the retarget cap to
            // prevent thrash when cv:auto keeps shifting the target.
            if (drift <= STABLE_BAND_PX || retargetCount >= MAX_RETARGETS) {
                this.spotlightRetargetTimerId = null;
                return;
            }
            smoothTo(desired);
            retargetCount++;
            this.spotlightRetargetTimerId = setTimeout(retargetTick, RETARGET_INTERVAL_MS) as unknown as number;
        };
        smoothTo(computeDesiredScrollTop());
        this.spotlightRetargetTimerId = setTimeout(retargetTick, RETARGET_INTERVAL_MS) as unknown as number;
        scrollEl.addEventListener('scrollend', onScrollEnd, { once: true, signal });
        scrollEl.addEventListener('wheel', onUserAbort, { passive: true, signal });
        scrollEl.addEventListener('touchstart', onUserAbort, { passive: true, signal });
        scrollEl.addEventListener('keydown', onUserAbort, { signal });
        this.spotlightTimerId = setTimeout(() => {
            if (fired || signal.aborted) return;
            const desired = computeDesiredScrollTop();
            if (Math.abs(desired - scrollEl.scrollTop) > TOLERANCE_PX) {
                smoothTo(desired);
            }
            fire();
        }, ChatComponent.SCROLL_STABILIZE_MAX_MS) as unknown as number;
    }

    onJumpToMessage(id: string, action: string | null = null) {
        // Both guards must flip sync at click time, not inside the deferred
        // measurement below. userScrolledUp halts smartScroll/correction
        // rAF loops; jumpInProgress also stops bottom-pin paths that reset
        // userScrolledUp=false mid-flight (status-change setTimeout, our
        // cv override's ResizeObserver). One-way until explicitly cleared.
        this.userScrolledUp = true;
        this.jumpInProgress = true;
        // Two rapid jumps must not let the earlier timer fire mid-second-hold.
        if (this.jumpTimeoutId !== null) clearTimeout(this.jumpTimeoutId);
        this.jumpTimeoutId = setTimeout(() => {
            this.jumpInProgress = false;
            this.jumpTimeoutId = null;
        }, ChatComponent.CV_OVERRIDE_HOLD_MS);
        // Reveal + pin BEFORE scroll math: revealing lets the target
        // contribute real height instead of cv-collapsed placeholder, and
        // pinning gives action spotlights an opacity:1 button to anchor to.
        this.revealMessage(id);
        this.pinToolbar(id);
        setTimeout(() => {
            const scrollEl = this.scrollContainer()?.nativeElement as HTMLElement | undefined;
            const el = this.findMessageElement(id);
            if (!el || !scrollEl) return;
            const actionBtn = action
                ? el.querySelector<HTMLElement>(`[data-msg-action="${CSS.escape(action)}"]`)
                : null;
            this.stabilizeScroll(scrollEl, el, () => {
                if (actionBtn) {
                    spotlightElement(actionBtn);
                } else {
                    this.flashMessage(id);
                }
            });
        }, ChatComponent.JUMP_TO_MESSAGE_DELAY_MS);
    }
}
