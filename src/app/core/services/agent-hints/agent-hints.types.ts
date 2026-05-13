import type { ElementRef } from '@angular/core';

/**
 * Static manifest entry. Describes one UI feature the in-app helper agent
 * can search for, point users at, and (when `activatable`) trigger.
 *
 * Tree-shaped: `children` are features only reachable after the parent's
 * element opens (dialog opened, panel expanded, tab switched). The full
 * path of an entry is the slash-joined chain of `id`s from root.
 *
 * Descriptions live in i18n dictionaries under `agentHint.<path>` (with
 * `.self` suffix for container entries that also have children). The
 * registry resolves them via `I18nService` at query time so locale
 * changes take effect immediately.
 */
export interface AgentHintEntry {
  /** Local segment, unique among siblings (NOT globally unique). */
  id: string;
  /** Extra fuzzy-search tokens; can mix languages so users searching in any locale hit the entry. */
  keywords?: string[];
  /** True = `?do=activate` may fire the component's open function via the directive's `(hintActivate)` output. */
  activatable?: boolean;
  /** Sub-features visible only after opening this entry. */
  children?: AgentHintEntry[];
}

/**
 * Runtime view of an entry, indexed by full path. Built once at registry
 * init by walking the manifest tree. `elementRef` and `onActivate` get
 * populated when an `AppAgentHintDirective` mounts on a matching element.
 *
 * `description` is NOT cached here — the registry resolves it via i18n
 * at each query so locale switches don't need a re-walk.
 */
export interface ResolvedEntry {
  entry: AgentHintEntry;
  path: string;
  parent: string | null;
  depth: number;
  elementRef: ElementRef | null;
  /** Set by directive `(hintActivate)` — fires the component's primary action (clicks the button, opens the dialog, runs the user-facing operation). */
  onActivate: (() => void) | undefined;
}

export type HintAction = 'highlight' | 'focus' | 'activate';
