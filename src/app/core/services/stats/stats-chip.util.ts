import { AppliedDelta } from '../../models/stats.types';

/** One rendered stat-change adornment for a model turn. */
export interface StatChip {
  label: string;
  kind: 'gain' | 'loss' | 'neutral' | 'dropped' | 'event';
  tooltip: string;
  /** A stat's declared chip color (CSS string); overrides the gain/loss tint when set. */
  color?: string;
}

/** Locale strings + per-stat colour lookup a chip needs but a pure builder must not own. */
export interface StatChipOptions {
  /** Tooltip shown on a triggered-event chip. */
  eventTooltip: string;
  /** Prefix shown before the reason on a dropped (rejected) change. */
  droppedPrefix: string;
  /** A stat key's declared chip color, or undefined to fall back to the gain/loss tint. */
  colorFor: (key: string) => string | undefined;
}

const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

function toStatChip(d: AppliedDelta, opts: StatChipOptions): StatChip {
  const target = d.field ? `${d.key}.${d.field}` : d.subkey ? `${d.key}.${d.subkey}` : d.key;
  if (d.dropped) {
    const requested = d.delta !== undefined ? signed(d.delta) : d.value !== undefined ? `=${d.value}` : '';
    return {
      label: requested ? `${target} ${requested}` : target,
      kind: 'dropped',
      tooltip: opts.droppedPrefix + (d.warning ?? d.reason ?? ''),
    };
  }
  const amount = d.after - d.before;
  return {
    label: `${target} ${signed(amount)}`,
    kind: amount > 0 ? 'gain' : amount < 0 ? 'loss' : 'neutral',
    tooltip: d.reason ?? '',
    color: opts.colorFor(d.key),
  };
}

/**
 * Build the chip adornments for one model turn — its applied stat audit followed
 * by any triggered events. Pure: locale strings and the per-stat colour lookup
 * are injected so the inline chat turn view and the turn-update side panel render
 * identical chips from one source. Returns [] for a turn that changed nothing.
 */
export function buildStatChips(
  applied: AppliedDelta[],
  triggered: string[],
  opts: StatChipOptions
): StatChip[] {
  const changes = applied.map(d => toStatChip(d, opts));
  const events = triggered.map<StatChip>(trigger => ({
    label: trigger,
    kind: 'event',
    tooltip: opts.eventTooltip,
  }));
  return [...changes, ...events];
}
