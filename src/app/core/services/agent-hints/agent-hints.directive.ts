import { Directive, ElementRef, effect, inject, input, output } from '@angular/core';
import { AgentHintRegistry } from './agent-hints.registry';

/**
 * Attach a manifest entry's live ElementRef + activate-handler to the
 * registry. Place on the actual button/control; do NOT use on container
 * divs. The directive does not display any UI of its own and does not
 * intercept hover — it is opt-in metadata that coexists with `matTooltip`.
 *
 * Usage:
 *   <button appAgentHint="chat-input/send" (click)="send()">…</button>
 *
 * Activatable entries (per manifest) also bind `(hintActivate)` so the
 * registry can fire the component's open function during a cascade
 * without sending a synthetic DOM click event:
 *   <button appAgentHint="chat-input/chat-config"
 *           (click)="openChatConfig()"
 *           (hintActivate)="openChatConfig()">…</button>
 *
 * The `appAgentHint` attribute value is the full slash-joined path matching
 * a manifest entry. Aliased to the selector so template stays terse.
 */
@Directive({
  selector: '[appAgentHint]',
  standalone: true,
})
export class AppAgentHintDirective {
  /** Full manifest path; sibling-unique id chain joined by `/`. */
  hintPath = input.required<string>({ alias: 'appAgentHint' });
  /** Fired by registry cascade when this entry should activate. Component re-runs its open handler. */
  hintActivate = output<void>();

  constructor() {
    const registry = inject(AgentHintRegistry);
    const elementRef = inject(ElementRef);

    effect((onCleanup) => {
      const path = this.hintPath();
      registry.attachElement(path, elementRef, () => this.hintActivate.emit());
      onCleanup(() => registry.detachElement(path, elementRef));
    });
  }
}
