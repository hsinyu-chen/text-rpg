import { Injectable, signal } from '@angular/core';

/**
 * A surface that owns an unsaved-edit buffer for KB files (typically the
 * file-viewer dialog backed by Monaco). The agent panel reads/writes through
 * this so file-viewer's existing Save flow stays the single persistence path.
 */
export interface AgentEditChannel {
  /** Returns the buffer's current view of every loaded file (Monaco-mirrored). */
  read: () => Map<string, string>;
  /** Apply an edit to the buffer (Monaco update + unsaved-flag bookkeeping). */
  write: (filename: string, content: string) => void;
}

/**
 * Cross-component state for the chat-side agent panel.
 *
 * Two independent concerns share this service:
 *   - `pipActive` — chat.component sets this when the panel is opened in a
 *     Document Picture-in-Picture window. Other surfaces (file-viewer) hide
 *     their own "open agent" button while this is true so we don't end up
 *     with two competing agent UIs.
 *   - `editChannel` — when an editing surface (file-viewer) is open it
 *     registers a read+write channel. The chat-side agent then reads from
 *     and writes to that surface's unsaved buffer instead of the engine's
 *     live `loadedFiles` map. Empty channel ⇒ agent runs read-only against
 *     live state.
 */
@Injectable({ providedIn: 'root' })
export class AgentPanelStateService {
  readonly pipActive = signal(false);
  readonly editChannel = signal<AgentEditChannel | null>(null);
  // Lifetime-stable draft input. AgentConsoleComponent is destroyed/recreated
  // on every panel toggle (chat-side toggle, PiP open/close), so a per-component
  // signal would wipe unsent text mid-thought. Hoisting onto the singleton
  // service preserves the draft across remounts — same lifetime as agentLogs.
  readonly draftPrompt = signal('');
  // Same rationale: dev-bridge fill ticks must outlive a remount so a stale
  // non-null fill request doesn't auto-replay runAgent on every reopen.
  lastFillTick = 0;
  // The PiP window's Document while a PiP panel is open; null otherwise.
  // PipAwareOverlayContainer reads this to route matTooltip / mat-menu /
  // mat-dialog overlays into the same doc the agent-console is currently
  // appended to, instead of the main window (where they'd otherwise render
  // invisible behind the PiP). chat.component sets/clears around the
  // requestWindow lifecycle.
  readonly pipDocument = signal<Document | null>(null);

  registerEditChannel(channel: AgentEditChannel): () => void {
    if (this.editChannel()) {
      console.warn('[agent-panel-state] another edit channel is already registered; overwriting');
    }
    this.editChannel.set(channel);
    return () => {
      if (this.editChannel() === channel) this.editChannel.set(null);
    };
  }
}
