import { Injectable, computed, inject, signal } from '@angular/core';
import { FileUpdate, FileUpdateService } from './file-update.service';
import { PromptRepository } from './storage/prompt.repository';
import { GameStateService } from './game-state.service';

/**
 * Per-profile local hunk patches on prompts. A patch is a {@link FileUpdate}
 * (target → replacement, anchored by a heading-breadcrumb context) matched
 * against the BASE prompt text. Patches compose into the effective prompt the
 * engine consumes; the chat-config editor still edits the base, so a patch is a
 * separate, removable overlay — and works on built-in profiles without cloning.
 *
 * Owns the in-memory hunks for the ACTIVE profile and their IDB persistence;
 * InjectionService orchestrates the effective-text recompute. A patch that no
 * longer matches (base drifted) is skipped and flagged, blocking send.
 */
@Injectable({ providedIn: 'root' })
export class PromptHunkOverrideService {
  private prompts = inject(PromptRepository);
  private fileUpdate = inject(FileUpdateService);
  private state = inject(GameStateService);

  private hunksByType = signal<ReadonlyMap<string, FileUpdate[]>>(new Map());

  /** Reactive patch count per prompt type — drives the chat-config per-type indicator. */
  counts = computed(() => {
    const m = new Map<string, number>();
    for (const [type, hunks] of this.hunksByType()) m.set(type, hunks.length);
    return m;
  });

  hunksFor(type: string): FileUpdate[] {
    return this.hunksByType().get(type) ?? [];
  }

  /** Load every type's hunks for a profile from IDB into memory (at resolution / profile switch). */
  async loadForProfile(profileId: string, types: readonly string[]): Promise<void> {
    const map = new Map<string, FileUpdate[]>();
    for (const type of types) {
      const raw = await this.prompts.getProfileHunks(type, profileId);
      if (raw.length) map.set(type, raw as FileUpdate[]);
    }
    this.hunksByType.set(map);
  }

  /** Persist + cache one type's hunks for a profile. */
  async setHunks(type: string, profileId: string, hunks: FileUpdate[]): Promise<void> {
    this.hunksByType.update((m) => {
      const next = new Map(m);
      if (hunks.length) next.set(type, hunks);
      else next.delete(type);
      return next;
    });
    await this.prompts.saveProfileHunks(type, profileId, hunks);
  }

  /** Copy one profile's hunks to another at clone time (IDB only — the clone isn't active). */
  async copyHunks(fromProfileId: string, toProfileId: string, types: readonly string[]): Promise<void> {
    for (const type of types) {
      const raw = await this.prompts.getProfileHunks(type, fromProfileId);
      if (raw.length) await this.prompts.saveProfileHunks(type, toProfileId, raw);
    }
  }

  /**
   * Apply the matched hunks to `base` in order, each validated against the
   * progressively-built result. A hunk that no longer matches is skipped and
   * surfaced via `anyFailed` (left unapplied rather than corrupting the text).
   */
  compose(base: string, hunks: readonly FileUpdate[]): { effective: string; anyFailed: boolean } {
    let result = base;
    let anyFailed = false;
    for (const hunk of hunks) {
      if (this.fileUpdate.validateAgainstContent(result, hunk).matched) {
        result = this.fileUpdate.applyUpdateToFile(result, hunk);
      } else {
        anyFailed = true;
      }
    }
    return { effective: result, anyFailed };
  }

  /** Recompute the global failing-types set from the current base text + hunks. */
  refreshValidation(): void {
    const base = this.state.promptBaseContent();
    const failing = new Set<string>();
    for (const [type, hunks] of this.hunksByType()) {
      if (!hunks.length) continue;
      if (this.compose(base.get(type) ?? '', hunks).anyFailed) failing.add(type);
    }
    this.state.hunkValidationError.set(failing);
  }
}
