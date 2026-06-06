import { Injectable, computed, inject } from '@angular/core';
import { AppliedDelta, ParsedStats, StatBounds, StatValues } from '../../models/stats.types';
import { GameStateService } from '../game-state.service';
import { StatLedgerService } from './stat-ledger.service';
import { buildStatBaseline, parseStats } from './stats-yaml.util';
import { getStatsYamlContent } from './stats-opt-in.util';

/** What one model message's stat chips render from. */
export interface MessageStatView {
  applied: AppliedDelta[];
  triggered: string[];
}

/**
 * Display-side re-derivation of per-message numeric-stat effects for the chat UI.
 *
 * The engine persists only each turn's raw `stat_delta`; current values, the
 * clamped/dropped audit, and triggered events are re-derived. This service does
 * the same on demand for a single message so the chat chip can show what a turn
 * ACTUALLY did (post-clamp, with drops) rather than the raw request — folding the
 * active-timeline history before that message (the same basis the engine uses)
 * onto the CURRENT stats definition, so editing the ledger reflows every chip.
 */
@Injectable({ providedIn: 'root' })
export class StatsViewService {
  private readonly gameState = inject(GameStateService);
  private readonly ledger = inject(StatLedgerService);

  // Re-parse the ledger whenever the loaded files change. Null when no Book
  // opted in or the YAML is unusable — a broken ledger simply yields no chips
  // (the engine logs the parse failure on its own per-turn path; re-logging here
  // every render would spam the console).
  private readonly snapshot = computed<{ parsed: ParsedStats; baseline: StatValues } | null>(() => {
    const content = getStatsYamlContent(this.gameState.loadedFiles());
    if (content === null) return null;
    try {
      const parsed = parseStats(content).parsed;
      return { parsed, baseline: buildStatBaseline(parsed) };
    } catch {
      return null;
    }
  });

  /**
   * Every active model message's applied audit + triggered events, folded in a
   * SINGLE forward pass off the current ledger. One pass — not one fold per
   * message — because the chat reads this for every rendered message on every
   * `messages()` emission (including each stream chunk), so a per-message refold
   * would be O(history²) per chunk and freeze the UI as history grows.
   *
   * ref-only messages are skipped (excluded from the active total, matching the
   * engine's fold basis); a message with no `stat_delta` gets no entry. `prev`
   * is the running state BEFORE each message — safe to alias because `fold` deep-
   * copies its value/bounds args, so it stays the pre-fold state for the event
   * evaluation. Warnings are discarded (a malformed event condition is surfaced
   * to the author at save time via validateStatsYaml); passing an array keeps
   * evaluateEvents off its console.warn fallback, which would otherwise fire on
   * every re-render.
   */
  private readonly auditByMessage = computed<Map<string, MessageStatView>>(() => {
    const out = new Map<string, MessageStatView>();
    const snap = this.snapshot();
    if (!snap) return out;

    let values: StatValues = snap.baseline;
    let bounds: StatBounds = {};
    for (const message of this.gameState.messages()) {
      if (message.role !== 'model' || message.isRefOnly) continue;
      const delta = message.stat_delta ?? [];
      const post = this.ledger.fold(snap.parsed, values, delta, bounds);
      if (delta.length > 0) {
        const triggered = this.ledger.evaluateEvents(
          snap.parsed,
          { values, bounds },
          post,
          snap.parsed.events,
          []
        );
        out.set(message.id, { applied: post.applied, triggered });
      }
      values = post.values;
      bounds = post.bounds;
    }
    return out;
  });

  /**
   * The applied stat audit + triggered events for one model message, or null
   * when there is nothing to show: stats are off / the YAML is unusable, the
   * message is unknown, carries no `stat_delta`, or is ref-only (its changes are
   * excluded from the active total, so showing them as "applied" would mislead).
   */
  appliedForMessage(messageId: string): MessageStatView | null {
    return this.auditByMessage().get(messageId) ?? null;
  }
}
