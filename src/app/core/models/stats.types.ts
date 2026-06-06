/**
 * Numeric stats data model. Lives in core/models (not core/services) so future
 * engine code and ChatMessage can import these types without creating a
 * models -> services back-dependency.
 */

/**
 * A single stat mutation produced for a turn.
 *
 * `field` selects WHAT the change targets:
 * - `"value"` (default / omitted) — the stat's live value. `delta` accumulates
 *   onto a scalar or an existing map subkey; `value` sets a brand-new map
 *   subkey's absolute initial amount (exactly one of the two).
 * - `"min"` / `"max"` — the stat's live lower / upper bound (growth, debuff
 *   caps). `delta` shifts the current bound; `value` sets it absolutely. The
 *   bound is stat-level, so `subkey` is ignored on a bound change.
 */
export interface StatChange {
  key: string;
  subkey?: string;
  delta?: number;
  value?: number;
  field?: 'value' | 'min' | 'max';
  reason?: string;
}

export interface StatDefinition {
  type: 'scalar' | 'map';
  min?: number;
  max?: number;
  value: number | Record<string, number>;
  desc?: string;
  allow_new_item?: boolean;
  new_item_rule?: string;
}

export interface StatEvent {
  condition: string;
  /** `level`: fires whenever the condition is truthy. `edge`: fires only on a false->true crossing. */
  type: 'level' | 'edge';
  trigger: string;
}

export interface ParsedStats {
  stats: Record<string, StatDefinition>;
  rules: string;
  events: StatEvent[];
}

/** Resolved current values: scalar stats -> number, map stats -> Record<subkey, number>. */
export type StatValues = Record<string, number | Record<string, number>>;

/**
 * Per-stat live bounds — the declared `min`/`max` folded with any `field:"min"`
 * / `field:"max"` changes. A stat ABSENT from this overlay still sits at its
 * declared bounds; an entry holds the absolute current bound (either side may be
 * `undefined` when that side is open). Stat-level, mirroring how
 * {@link StatDefinition}'s `min`/`max` are shared across a map's subkeys.
 */
export type StatBounds = Record<string, { min?: number; max?: number }>;

/** A point-in-time resolved stat state: live values together with live bounds. */
export interface StatState {
  values: StatValues;
  bounds: StatBounds;
}

/**
 * Audit record for one applied (or dropped) {@link StatChange}, retained for the
 * save log and UI. `before`/`after` are the scalar/subkey numbers around the
 * change; `dropped` marks an authorization/validation reject (values untouched);
 * `warning` carries a human-readable note for any non-clean application.
 */
export interface AppliedDelta {
  key: string;
  subkey?: string;
  /**
   * Which bound `before`/`after` describe — present ONLY for a bound change
   * (`field:"min"` / `field:"max"`). Absent for an ordinary value change, where
   * `before`/`after` are the scalar / subkey numbers.
   */
  field?: 'min' | 'max';
  before: number;
  after: number;
  delta?: number;
  value?: number;
  reason?: string;
  dropped?: boolean;
  warning?: string;
}
