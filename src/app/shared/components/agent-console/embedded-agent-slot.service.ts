import { Injectable, signal, ViewContainerRef } from '@angular/core';

/**
 * Wires together two cross-component concerns:
 *   - AppComponent renders the in-page sibling slot for the agent panel and
 *     registers its `ViewContainerRef` here once the view is initialized.
 *   - {@link AgentPanelPortalService} (provided at ChatComponent scope) reads
 *     that vcr at mount time to attach ChatComponent's `<ng-template>` into
 *     AppComponent's DOM subtree.
 *
 * Splitting the slot out lets the agent template keep ChatComponent's
 * injector context (so the scoped `FileAgentService` remains the agent's
 * owner) even though the DOM lives in the AppComponent shell — the
 * `createEmbeddedView` call still resolves DI through ChatComponent's
 * `ViewContainerRef`, only the parent DOM node changes.
 */
@Injectable({ providedIn: 'root' })
export class EmbeddedAgentSlotService {
  private readonly slot = signal<ViewContainerRef | null>(null);

  set(vcr: ViewContainerRef | null): void {
    this.slot.set(vcr);
  }

  get(): ViewContainerRef | null {
    return this.slot();
  }
}
