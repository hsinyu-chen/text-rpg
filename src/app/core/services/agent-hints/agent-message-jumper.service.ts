import { Injectable, signal } from '@angular/core';

/**
 * Dispatch surface for `app://message/<id>[/<action>]` links from the
 * agent-console. Chat.component watches `request` via effect and calls
 * its own `onJumpToMessage(id, action?)` on tick increment.
 *
 * The hint-registry can't own this because messages are an array (each
 * message a separate id), so they don't fit the manifest model. The
 * interceptor calls `jumpTo(id, action?)` here and chat.component picks
 * up the signal; if chat.component isn't mounted the jump is a no-op,
 * which is the right behavior (no chat view = nothing to scroll to).
 *
 * `action` is the optional second path segment — names a toolbar action
 * on that specific message (e.g. `auto-update`, `fork`). When present,
 * chat.component spotlights that button instead of flashing the whole
 * message bubble.
 */
@Injectable({ providedIn: 'root' })
export class AgentMessageJumperService {
  /** Tick-versioned id+action payload; null pre-first-jump. */
  readonly request = signal<{ id: string; action: string | null; tick: number } | null>(null);

  jumpTo(id: string, action: string | null = null): void {
    this.request.update(v => ({ id, action, tick: (v?.tick ?? 0) + 1 }));
  }
}
