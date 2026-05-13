import { Injectable, inject, DestroyRef } from '@angular/core';
import { OverlayContainer } from '@angular/cdk/overlay';
import { AgentPanelStateService } from '@app/core/services/file-agent/agent-panel-state.service';

/**
 * OverlayContainer that follows the agent-console into a Document
 * Picture-in-Picture window.
 *
 * `matTooltip` / `mat-menu` / `mat-dialog` and other CDK overlays attach
 * to a single `cdk-overlay-container` div appended to a body. The base
 * `OverlayContainer` is provided at app root and caches that div in the
 * main document — once the agent-console is moved into a PiP window the
 * tooltips still render in the main doc, behind / beside the PiP window
 * where the user can't see them.
 *
 * Provided at agent-console scope: only overlays opened from descendants
 * (the agent panel itself, its dropdowns) get routed to PiP. Chat
 * messages and the rest of the main UI keep the default root container.
 *
 * Container per doc is cached separately so we don't churn the DOM on
 * every tooltip — a single sibling `cdk-overlay-container` lives in each
 * body for as long as the PiP window is open.
 */
@Injectable()
export class PipAwareOverlayContainer extends OverlayContainer {
  private readonly panelState = inject(AgentPanelStateService);
  private pipContainerElement: HTMLElement | null = null;
  private mainContainerElement: HTMLElement | null = null;

  constructor() {
    super();
    // Base OverlayContainer.ngOnDestroy only cleans whichever container
    // was last assigned to _containerElement; the other one would leak in
    // its host doc every time agent-console is destroyed (panel toggle,
    // PiP close). DestroyRef.onDestroy runs alongside base's hook —
    // additive cleanup, no override.
    inject(DestroyRef).onDestroy(() => {
      this.pipContainerElement?.remove();
      this.mainContainerElement?.remove();
      this.pipContainerElement = null;
      this.mainContainerElement = null;
    });
  }

  override getContainerElement(): HTMLElement {
    const pipDoc = this.panelState.pipActive() ? this.panelState.pipDocument() : null;
    if (pipDoc) {
      // Reuse only when the cached container still belongs to THIS pipDoc.
      // After a PiP close+reopen the old container is still attached to the
      // now-detached body of the dead window, so `isConnected` stays true
      // and naive reuse would route overlays into an invisible doc. Compare
      // ownerDocument to be sure we're on the live window.
      if (!this.pipContainerElement || this.pipContainerElement.ownerDocument !== pipDoc) {
        this.pipContainerElement = this.createContainerIn(pipDoc);
      }
      this._containerElement = this.pipContainerElement;
      return this.pipContainerElement;
    }
    // No PiP — use (or create) the main-window container.
    if (!this.mainContainerElement || !this.mainContainerElement.isConnected) {
      // Reset base's cache so its _createContainer fires against the main
      // document.
      (this as unknown as { _containerElement: HTMLElement | null })._containerElement = null!;
      super.getContainerElement();
      this.mainContainerElement = this._containerElement;
    }
    this._containerElement = this.mainContainerElement!;
    return this.mainContainerElement!;
  }

  private createContainerIn(doc: Document): HTMLElement {
    const container = doc.createElement('div');
    container.classList.add('cdk-overlay-container');
    doc.body.appendChild(container);
    return container;
  }
}
