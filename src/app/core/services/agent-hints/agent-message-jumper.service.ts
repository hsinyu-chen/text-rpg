import { Injectable, signal } from '@angular/core';

/**
 * Dispatch surface for `app://message/<id>` links from the agent-console.
 * Chat.component watches `request` via effect and calls its own
 * `onJumpToMessage(id)` on tick increment.
 *
 * The hint-registry can't own this because messages are an array (each
 * message a separate id), so they don't fit the manifest model. The
 * interceptor calls `jumpTo(id)` here and chat.component picks up the
 * signal; if chat.component isn't mounted the jump is a no-op, which is
 * the right behavior (no chat view = nothing to scroll to).
 */
@Injectable({ providedIn: 'root' })
export class AgentMessageJumperService {
  /** Tick-versioned id payload; null pre-first-jump. */
  readonly request = signal<{ id: string; tick: number } | null>(null);

  jumpTo(id: string): void {
    this.request.update(v => ({ id, tick: (v?.tick ?? 0) + 1 }));
  }
}
