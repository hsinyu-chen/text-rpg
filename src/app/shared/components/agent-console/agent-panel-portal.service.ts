import { DOCUMENT } from '@angular/common';
import { EmbeddedViewRef, Injectable, TemplateRef, ViewContainerRef, inject } from '@angular/core';
import { AgentPanelStateService } from '@app/core/services/file-agent/agent-panel-state.service';

interface MountOptions {
  /** Called when the user closes the PiP window via OS chrome (so the caller
   *  can flip its own open-state signal back to false). Not invoked for the
   *  explicit unmount() path — the caller already knows in that case. */
  onPipClosed: () => void;
}

interface PipApi { requestWindow: (opts: { width?: number; height?: number }) => Promise<Window> }

/**
 * Mounts an agent-panel template into either a Document Picture-in-Picture
 * window (Chrome 116+) or a body-portal `<div popover="manual">` fallback.
 *
 * Provided at ChatComponent scope (not root) because the mount target —
 * a TemplateRef + ViewContainerRef — is a per-component concept. Owning
 * the full lifecycle here keeps ChatComponent focused on chat behavior.
 *
 * The two surfaces (PiP / body-portal) and their quirks (top-layer
 * re-promotion when other popovers open, MutationObserver-mirrored
 * stylesheets so Material's lazily-injected component styles reach the
 * PiP doc) all live in this file.
 */
@Injectable()
export class AgentPanelPortalService {
  private readonly doc = inject(DOCUMENT);
  private readonly panelState = inject(AgentPanelStateService);

  // Time window in which a click inside the panel "claims" any subsequent
  // popover-open as ours, so the promoter doesn't re-promote our host on
  // top of our own descendant dropdowns (mat-select / mat-menu). Wide
  // enough to absorb the natural delay between a click handler firing and
  // the resulting popover actually opening, narrow enough that an unrelated
  // popover opening shortly after a panel click is still re-promoted.
  private static readonly POPOVER_OWNERSHIP_DEBOUNCE_MS = 400;

  // Generation token: every mount/unmount bumps this. Async PiP open
  // (`requestWindow` awaits a user gesture / permission grant) checks
  // the token after resume; if it changed (panel was closed during the
  // await), the open path aborts cleanly instead of attaching a zombie
  // window.
  private mountGeneration = 0;
  private view: EmbeddedViewRef<unknown> | null = null;
  private host: HTMLDivElement | null = null;
  private pipWin: Window | null = null;
  private pipStyleObserver: MutationObserver | null = null;
  private popoverPromoter: ((e: Event) => void) | null = null;
  private clickTracker: ((e: Event) => void) | null = null;
  private lastOwnClickAt = 0;

  mount(tpl: TemplateRef<unknown>, vcr: ViewContainerRef, opts: MountOptions): void {
    if (this.view || this.pipWin) return;
    const gen = ++this.mountGeneration;
    this.view = vcr.createEmbeddedView(tpl);
    this.view.detectChanges();
    const rootNodes = this.view.rootNodes as Node[];

    // Prefer the native Document Picture-in-Picture API when available
    // (Chrome 116+). It opens the agent panel in a separate browser
    // window — no top-layer fighting with main-app dialogs/menus, and
    // the panel's own dropdowns just work because the PiP window has
    // its own top-layer scope. Falls back to body-portal + popover on
    // browsers that don't support it (Firefox / Safari today).
    const pipApi = (this.doc.defaultView as Window & {
      documentPictureInPicture?: PipApi;
    } | null)?.documentPictureInPicture;
    if (pipApi) {
      void this.openInPip(pipApi, rootNodes, gen, opts);
    } else {
      this.openInBodyPortal(rootNodes);
    }
  }

  unmount(): void {
    // Invalidate any in-flight openInPip awaiting requestWindow.
    this.mountGeneration++;
    this.uninstallPopoverPromoter();
    this.panelState.pipActive.set(false);
    this.panelState.pipDocument.set(null);
    this.pipStyleObserver?.disconnect();
    this.pipStyleObserver = null;
    if (this.pipWin) {
      try { this.pipWin.close(); } catch { /* already closed */ }
      this.pipWin = null;
    }
    if (this.host?.matches(':popover-open')) {
      try { this.host.hidePopover(); } catch { /* race */ }
    }
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
  }

  private async openInPip(api: PipApi, rootNodes: Node[], gen: number, opts: MountOptions): Promise<void> {
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
    this.mirrorStylesToPip(pipWin);
    pipWin.document.body.style.margin = '0';
    pipWin.document.body.style.height = '100vh';
    pipWin.document.body.style.overflow = 'hidden';
    // Mark the body so the shell stretches edge-to-edge inside the PiP
    // window instead of its default min(480px, 92vw) which leaves gutters
    // when the user resizes the PiP smaller than 480px.
    pipWin.document.body.classList.add('agent-panel-pip');
    for (const n of rootNodes) pipWin.document.body.appendChild(n);
    this.pipWin = pipWin;
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
      if (this.pipWin === pipWin) {
        this.pipWin = null;
        this.panelState.pipDocument.set(null);
        this.pipStyleObserver?.disconnect();
        this.pipStyleObserver = null;
        opts.onPipClosed();
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
   *
   * Snapshot the existing `<link>` / `<style>` + adoptedStyleSheets at
   * open time, then watch `<head>` for future additions/removals while
   * PiP is up. The observer is torn down on unmount or pagehide.
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
    // Belt-and-braces for Constructable-Stylesheet toolchains —
    // CSSStyleSheet instances are document-scoped, so we re-materialize
    // the rules as fresh sheets in the PiP doc.
    try {
      const srcSheets = this.doc.adoptedStyleSheets;
      if (srcSheets?.length) {
        const pipCtor = (pipWin as Window & { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
        if (pipCtor) {
          pipWin.document.adoptedStyleSheets = srcSheets.map(src => {
            const sheet = new pipCtor();
            const cssText = Array.from(src.cssRules).map(r => r.cssText).join('\n');
            sheet.replaceSync(cssText);
            return sheet;
          });
        }
      }
    } catch { /* cross-origin import — covered by <link> clone */ }

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

  private openInBodyPortal(rootNodes: Node[]): void {
    if (!this.host) {
      this.host = this.doc.createElement('div');
      this.host.className = 'agent-panel-host';
      // popover="manual" puts us in the browser top-layer alongside
      // every cdk-overlay dialog (CDK 19+ uses the same API). Within
      // top-layer z-index is ignored; ordering is purely "last shown
      // wins", so we re-promote ourselves whenever a sibling popover
      // opens, unless the click that triggered it came from inside
      // the panel (own dropdown / menu) — see installPopoverPromoter.
      this.host.setAttribute('popover', 'manual');
      this.doc.body.appendChild(this.host);
    }
    for (const node of rootNodes) {
      this.host.appendChild(node);
    }
    try { this.host.showPopover(); } catch { /* not connected / no support */ }
    this.installPopoverPromoter();
  }

  private installPopoverPromoter(): void {
    if (this.popoverPromoter) return;
    // Whenever ANY other popover opens (Material dialogs use the same
    // popover API since CDK 19), re-show ours to bring it back to the
    // top of the top-layer — UNLESS the popover that just opened is
    // our own descendant (mat-select / mat-menu triggered from a click
    // inside the panel). Detected temporally: a click inside the panel
    // within the last 400ms marks any subsequent popover-open as
    // "ours". Without this guard the panel covers its own dropdowns.
    this.clickTracker = (e: Event) => {
      if (this.host?.contains(e.target as Node)) {
        this.lastOwnClickAt = Date.now();
      }
    };
    this.doc.addEventListener('click', this.clickTracker, true);

    this.popoverPromoter = (e: Event) => {
      const target = e.target as HTMLElement;
      if (!this.host || target === this.host) return;
      const toggle = e as ToggleEvent;
      if (toggle.newState !== 'open') return;
      if (Date.now() - this.lastOwnClickAt < AgentPanelPortalService.POPOVER_OWNERSHIP_DEBOUNCE_MS) return;
      queueMicrotask(() => {
        const host = this.host;
        if (!host || !host.matches(':popover-open')) return;
        try { host.hidePopover(); host.showPopover(); } catch { /* race */ }
      });
    };
    this.doc.addEventListener('toggle', this.popoverPromoter, true);
  }

  private uninstallPopoverPromoter(): void {
    if (this.popoverPromoter) {
      this.doc.removeEventListener('toggle', this.popoverPromoter, true);
      this.popoverPromoter = null;
    }
    if (this.clickTracker) {
      this.doc.removeEventListener('click', this.clickTracker, true);
      this.clickTracker = null;
    }
  }
}
