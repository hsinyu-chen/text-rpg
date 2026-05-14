import { Injectable, signal } from '@angular/core';

/**
 * Dispatch surface for `app://book/<id>[/<action>]` and
 * `app://collection/<id>[/<action>]` links from the agent-console.
 * BookListComponent watches `request` via effect; if it isn't mounted
 * (sidebar closed / different tab) the jump is a no-op, same contract
 * as AgentMessageJumperService.
 *
 * Books and collections are arrays — each row a separate id — so they
 * cannot fit the hint-registry's one-elementRef-per-path model. The
 * interceptor calls `jump()` here; book-list resolves the id, scrolls
 * the row into view, and either spotlights it (no action) or calls the
 * named handler (rename / delete / move / add).
 *
 * `kind` discriminates between the two schemes; `action` mirrors the
 * one-optional-segment shape of `app://message/<id>/<action>`.
 */
export type BookJumpKind = 'book' | 'collection';

export interface BookJumpRequest {
  kind: BookJumpKind;
  id: string;
  action: string | null;
  tick: number;
}

@Injectable({ providedIn: 'root' })
export class AgentBookJumperService {
  readonly request = signal<BookJumpRequest | null>(null);

  jump(kind: BookJumpKind, id: string, action: string | null = null): void {
    this.request.update(v => ({ kind, id, action, tick: (v?.tick ?? 0) + 1 }));
  }
}
