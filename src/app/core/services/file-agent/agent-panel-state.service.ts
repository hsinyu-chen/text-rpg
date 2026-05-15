import { Injectable, computed, inject, signal } from '@angular/core';
import { KVStore } from '../kv/kv-store';

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
 * User's preferred presentation for the chat-side agent panel. Persisted across
 * sessions; `'pip'` falls back to `'embedded'` at startup if the runtime has no
 * `documentPictureInPicture` API.
 */
export type AgentPanelMode = 'pip' | 'embedded';

const PREFERRED_MODE_KEY = 'agentPanel.preferredMode';

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
  private readonly kv = inject(KVStore);

  readonly pipActive = signal(false);
  /**
   * Whether the chat-side agent panel is currently open. Hoisted to root
   * scope (away from ChatComponent's local signal) so the AppComponent shell
   * can render or hide the in-page embedded slot without reaching into
   * ChatComponent.
   */
  readonly isOpen = signal(false);
  readonly editChannel = signal<AgentEditChannel | null>(null);
  /**
   * Persisted user preference for how the chat-side agent panel surfaces when
   * opened. The portal service consults this at mount time and downgrades to
   * 'embedded' when the platform has no PiP API.
   */
  readonly preferredMode = signal<AgentPanelMode>(this.loadPreferredMode());
  /**
   * Convenience: true when the panel is currently mounted in the in-page
   * embedded slot (preferred mode is 'embedded' and no PiP is active). The
   * AppComponent's @if uses this to decide whether to render the slot.
   */
  readonly embedded = computed(() => this.preferredMode() === 'embedded' && !this.pipActive());

  setPreferredMode(mode: AgentPanelMode): void {
    this.preferredMode.set(mode);
    this.kv.set(PREFERRED_MODE_KEY, mode);
  }

  private loadPreferredMode(): AgentPanelMode {
    const raw = this.kv.get(PREFERRED_MODE_KEY);
    return raw === 'pip' || raw === 'embedded' ? raw : 'embedded';
  }
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
