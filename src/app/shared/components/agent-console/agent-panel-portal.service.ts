import { DOCUMENT } from '@angular/common';
import { EmbeddedViewRef, Injectable, TemplateRef, ViewContainerRef, inject } from '@angular/core';
import { AgentPanelStateService } from '@app/core/services/file-agent/agent-panel-state.service';
import { EmbeddedAgentSlotService } from './embedded-agent-slot.service';

/**
 * Reason the PiP window's `pagehide` fired — distinguishes Chrome's two
 * native PiP chrome buttons:
 *   - `'back-to-tab'`: user clicked the back-to-tab button (and the spec'd
 *     behavior of refocusing the opener gives us a usable signal — see
 *     pagehide handler below).
 *   - `'close'`: user clicked the close X (or the window was closed via
 *     `window.close()` / OS-level dismissal).
 *
 * Document Picture-in-Picture provides no formal event-level distinction;
 * both paths fire only `pagehide`. The discriminator is `document.hasFocus()`
 * on the main window at `pagehide` time: back-to-tab transfers focus to the
 * opener BEFORE pagehide (the user asked for the opener tab), close X drops
 * the window without re-focusing the opener. Verified empirically on
 * Chromium 130+.
 */
export type PipCloseReason = 'back-to-tab' | 'close';

interface MountOptions {
  /** Called when the PiP window closes via OS chrome (not invoked for the
   *  explicit unmount() path — the caller already knows in that case). The
   *  `reason` lets the caller route back-to-tab to a dock-back path and
   *  close to a full panel-close. */
  onPipClosed: (reason: PipCloseReason) => void;
}

interface PipApi { requestWindow: (opts: { width?: number; height?: number }) => Promise<Window> }

/**
 * Mounts an agent-panel template into one of two surfaces:
 *   - **PiP** (Chrome 116+ `documentPictureInPicture`) — separate browser
 *     window with its own top-layer scope; dialogs in the main window never
 *     compete with the panel.
 *   - **Embedded** — an in-page sibling slot owned by AppComponent (via
 *     {@link EmbeddedAgentSlotService}). Lives in normal stacking order
 *     next to `mat-sidenav-container`, so the main-window CDK overlay
 *     container (which {@link PipAwareOverlayContainer} now appends inside
 *     mat-sidenav-content) cannot cover it.
 *
 * Provided at ChatComponent scope so the agent panel's owning template
 * retains ChatComponent's injector context across PIP/embedded swaps —
 * the portal moves the embedded view between surfaces without
 * re-creating it, which would otherwise lose any view-local state.
 */
@Injectable()
export class AgentPanelPortalService {
  private readonly doc = inject(DOCUMENT);
  private readonly panelState = inject(AgentPanelStateService);
  private readonly embeddedSlot = inject(EmbeddedAgentSlotService);

  // Generation token: every mount/unmount bumps this. Async PiP open
  // (`requestWindow` awaits a user gesture / permission grant) checks the
  // token after resume; if it changed (panel was closed during the await),
  // the open path aborts cleanly instead of attaching a zombie window.
  private mountGeneration = 0;
  private view: EmbeddedViewRef<unknown> | null = null;
  private pipWin: Window | null = null;
  private pipStyleObserver: MutationObserver | null = null;
  private currentMode: 'pip' | 'embedded' | null = null;

  isPipSupported(): boolean {
    return !!this.getPipApi();
  }

  /**
   * Mount the agent panel into its preferred surface. Honors
   * `panelState.preferredMode`, with automatic downgrade to `'embedded'`
   * if the platform lacks PiP support. Idempotent in the same mode.
   */
  mount(tpl: TemplateRef<unknown>, fallbackVcr: ViewContainerRef, opts: MountOptions): void {
    const wantPip = this.panelState.preferredMode() === 'pip' && this.isPipSupported();
    if (this.currentMode === 'pip' && wantPip) return;
    if (this.currentMode === 'embedded' && !wantPip) return;

    // Mode change (or first mount) — tear down whichever surface is up.
    this.teardown();
    const gen = ++this.mountGeneration;

    if (wantPip) {
      this.currentMode = 'pip';
      // View creation is deferred until requestWindow resolves — see
      // openInPip below. Building it eagerly here would attach the agent
      // DOM to the main document while the user is still approving the
      // PiP permission prompt; if the slot isn't registered yet and the
      // fallbackVcr lands the nodes somewhere with no `display: none`
      // protection, the panel briefly flashes in the chat UI.
      void this.openInPip(tpl, fallbackVcr, gen, opts);
    } else {
      // Embedded mode requires the AppComponent slot to have registered. If
      // it hasn't yet (e.g. first mount fires before AppComponent's @if
      // renders), bail — the AgentPanelStateService.isOpen + embedded()
      // signal will retrigger the chat-side effect once the slot appears.
      const vcr = this.embeddedSlot.get();
      if (!vcr) {
        this.currentMode = null;
        return;
      }
      this.currentMode = 'embedded';
      this.view = vcr.createEmbeddedView(tpl);
      this.view.detectChanges();
    }
  }

  unmount(): void {
    this.mountGeneration++;
    this.teardown();
  }

  private teardown(): void {
    this.panelState.pipActive.set(false);
    this.panelState.pipDocument.set(null);
    this.pipStyleObserver?.disconnect();
    this.pipStyleObserver = null;
    if (this.pipWin) {
      try { this.pipWin.close(); } catch { /* already closed */ }
      this.pipWin = null;
    }
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.currentMode = null;
  }

  private getPipApi(): PipApi | undefined {
    return (this.doc.defaultView as Window & {
      documentPictureInPicture?: PipApi;
    } | null)?.documentPictureInPicture;
  }

  private async openInPip(
    tpl: TemplateRef<unknown>,
    fallbackVcr: ViewContainerRef,
    gen: number,
    opts: MountOptions
  ): Promise<void> {
    const api = this.getPipApi();
    if (!api) {
      // Caller already gated on isPipSupported() but the API may have
      // disappeared between checks (extension toggle, etc.) — downgrade
      // by reflecting the preference back to embedded and remounting on
      // the next state change.
      this.panelState.setPreferredMode('embedded');
      return;
    }
    let pipWin: Window;
    const pipWidth = 480;
    const pipHeight = 720;
    try {
      pipWin = await api.requestWindow({ width: pipWidth, height: pipHeight });
    } catch {
      // user denied / call rejected (e.g. no user gesture). If the panel
      // wasn't closed during the await, downgrade preference to embedded
      // so the next mount tick lands the user in the in-page slot.
      if (gen !== this.mountGeneration) return;
      this.panelState.setPreferredMode('embedded');
      return;
    }
    if (gen !== this.mountGeneration) {
      try { pipWin.close(); } catch { /* already closed */ }
      return;
    }
    // Park the PiP next to the main window's right edge.
    try {
      const mainWin = this.doc.defaultView;
      if (mainWin) {
        const gap = 8;
        const targetX = mainWin.screenX + mainWin.outerWidth + gap;
        const targetY = mainWin.screenY;
        const screen = mainWin.screen as Screen & { availLeft?: number };
        const maxX = (screen.availLeft ?? 0) + screen.availWidth - pipWidth;
        pipWin.moveTo(Math.min(targetX, maxX), targetY);
      }
    } catch { /* moveTo blocked / unsupported — fall back to OS placement */ }
    this.mirrorStylesToPip(pipWin);
    pipWin.document.body.style.margin = '0';
    pipWin.document.body.style.height = '100vh';
    pipWin.document.body.style.overflow = 'hidden';
    pipWin.document.body.classList.add('agent-panel-pip');
    // Create the embedded view now (after requestWindow resolved). The
    // intermediate "in main DOM" state lasts only one microtask before
    // we relocate root nodes into the PiP doc — short enough that the
    // browser's next paint already sees the nodes in the PiP window.
    const vcr = this.embeddedSlot.get() ?? fallbackVcr;
    this.view = vcr.createEmbeddedView(tpl);
    this.view.detectChanges();
    const rootNodes = this.view.rootNodes as Node[];
    for (const n of rootNodes) pipWin.document.body.appendChild(n);
    this.pipWin = pipWin;
    this.panelState.pipDocument.set(pipWin.document);
    this.panelState.pipActive.set(true);

    const mainWin = this.doc.defaultView;
    pipWin.addEventListener('pagehide', () => {
      // Distinguish Chrome's two PiP chrome buttons via main-window focus
      // state — see PipCloseReason JSDoc. back-to-tab re-focuses the opener
      // before this event fires, close X does not.
      const reason: PipCloseReason = mainWin?.document?.hasFocus?.()
        ? 'back-to-tab'
        : 'close';
      if (this.pipWin === pipWin) {
        this.pipWin = null;
        this.panelState.pipDocument.set(null);
        this.panelState.pipActive.set(false);
        this.pipStyleObserver?.disconnect();
        this.pipStyleObserver = null;
        opts.onPipClosed(reason);
      }
    });
  }

  /**
   * Live-mirror main-doc stylesheets into the PiP doc — Angular Material 19
   * injects per-component `<style>` tags into `<head>` lazily on each
   * component's first render, and matSpinner / matTooltip first render
   * typically happens AFTER `requestWindow` resolves. A one-shot snapshot
   * misses those late additions and the PiP renders unstyled (spinner
   * SVGs as black-filled circles, etc).
   */
  private mirrorStylesToPip(pipWin: Window): void {
    const srcHead = this.doc.head;
    const destHead = pipWin.document.head;
    const cloneMap = new WeakMap<Node, Node>();

    const cloneAndAppend = (node: Node): void => {
      const clone = node.cloneNode(true);
      cloneMap.set(node, clone);
      destHead.appendChild(clone);
    };

    for (const n of Array.from(srcHead.querySelectorAll('link[rel="stylesheet"], style'))) {
      cloneAndAppend(n);
    }
    // adoptedStyleSheets — one-shot snapshot (no native observer for these).
    // Per-sheet try/catch: one cross-origin SecurityError must not drop
    // accessible same-origin sheets.
    const srcSheets = this.doc.adoptedStyleSheets;
    if (srcSheets?.length) {
      const pipCtor = (pipWin as Window & { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
      if (pipCtor) {
        const cloned: CSSStyleSheet[] = [];
        for (const src of srcSheets) {
          try {
            const sheet = new pipCtor();
            const cssText = Array.from(src.cssRules).map(r => r.cssText).join('\n');
            sheet.replaceSync(cssText);
            cloned.push(sheet);
          } catch { /* cross-origin / inaccessible — covered by <link> clone */ }
        }
        pipWin.document.adoptedStyleSheets = cloned;
      }
    }

    this.pipStyleObserver = new MutationObserver(records => {
      for (const rec of records) {
        for (const added of Array.from(rec.addedNodes)) {
          if (added instanceof HTMLStyleElement || (added instanceof HTMLLinkElement && added.rel === 'stylesheet')) {
            cloneAndAppend(added);
          }
        }
        for (const removed of Array.from(rec.removedNodes)) {
          const clone = cloneMap.get(removed);
          if (clone) {
            (clone as ChildNode).remove();
            cloneMap.delete(removed);
          }
        }
      }
    });
    this.pipStyleObserver.observe(srcHead, { childList: true });
  }
}
