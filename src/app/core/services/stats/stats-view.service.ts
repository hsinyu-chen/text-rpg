import { Injectable, computed, inject } from '@angular/core';
import { AppliedDelta, ParsedStats, StatValues } from '../../models/stats.types';
import { GameStateService } from '../game-state.service';
import { StatLedgerService } from './stat-ledger.service';
import { buildStatBaseline, parseStats } from './stats-yaml.util';
import { getStatsYamlContent, priorStatDeltaLists } from './stats-opt-in.util';

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

  // Parse the ledger once per content change. Null when no Book opted in or the
  // YAML is unusable — a broken ledger simply yields no chips (the engine logs
  // the parse failure on its own per-turn path; re-logging here every render
  // would spam the console).
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
   * The applied stat audit + triggered events for one model message, or null
   * when there is nothing to show: stats are off / the YAML is unusable, the
   * message is unknown, carries no `stat_delta`, or is ref-only (its changes are
   * excluded from the active total, so showing them as "applied" would mislead).
   */
  appliedForMessage(messageId: string): MessageStatView | null {
    const snap = this.snapshot();
    if (!snap) return null;

    const messages = this.gameState.messages();
    const index = messages.findIndex(m => m.id === messageId);
    if (index < 0) return null;

    const message = messages[index];
    if (message.isRefOnly || !message.stat_delta || message.stat_delta.length === 0) return null;

    const prior = priorStatDeltaLists(messages.slice(0, index));
    const prev = this.ledger.computeCurrent(snap.parsed, snap.baseline, prior);
    const post = this.ledger.fold(snap.parsed, prev.values, message.stat_delta, prev.bounds);
    const triggered = this.ledger.evaluateEvents(snap.parsed, prev, post, snap.parsed.events);
    return { applied: post.applied, triggered };
  }
}
