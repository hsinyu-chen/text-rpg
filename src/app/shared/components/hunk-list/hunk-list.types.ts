import { WritableSignal } from '@angular/core';
import { FileUpdate, ValidationResult } from '@app/core/services/file-update.types';

/** Persisted hunk shape — the model value of {@link HunkListComponent}. */
export type Hunk = FileUpdate;

/** A finished text selection handed in by the host editor. */
export interface HunkSelection {
  text: string;
  /** 1-indexed (Monaco convention) — the component converts before inferring context. */
  startLineNumber: number;
}

/**
 * Capability flags toggling the list's optional affordances. Each host opts in
 * to what it needs; everything defaults off so a bare `<app-hunk-list>` is a
 * read-only validating list.
 */
export interface HunkListConfig {
  /** Offer the LLM auto-fix button + "fix all" (auto-update). */
  autofixEnable?: boolean;
  /** A text selection seeds a brand-new hunk (prompt patch). */
  allowCreateFromSelection?: boolean;
  /** Per-hunk include/exclude checkbox; unselected hunks are not applied (auto-update). */
  selectable?: boolean;
  /** Drag to reorder (auto-update). */
  dragReorder?: boolean;
}

/** Internal working item: a persisted hunk plus its transient UI-only state. */
export interface HunkItem extends FileUpdate {
  id: string;
  selected: WritableSignal<boolean>;
  /**
   * Consecutive LLM repair attempts on this hunk that still failed to match.
   * Saturating at the controller's max hides the button.
   */
  autoFixAttempts: WritableSignal<number>;
  /** True while a fix LLM call is in flight; the button shows a spinner. */
  autoFixInProgress: WritableSignal<boolean>;
}

export type { ValidationResult };
