/**
 * Numeric stats data model. Lives in core/models (not core/services) so future
 * engine code and ChatMessage can import these types without creating a
 * models -> services back-dependency.
 */

/**
 * A single stat mutation produced for a turn.
 *
 * Invariant: exactly one of `delta` | `value` is set per change — `delta` for a
 * scalar or an existing map subkey (accumulates); `value` for a brand-new map
 * subkey (absolute initial amount).
 */
export interface StatChange {
  key: string;
  subkey?: string;
  delta?: number;
  value?: number;
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
 * Audit record for one applied (or dropped) {@link StatChange}, retained for the
 * save log and UI. `before`/`after` are the scalar/subkey numbers around the
 * change; `dropped` marks an authorization/validation reject (values untouched);
 * `warning` carries a human-readable note for any non-clean application.
 */
export interface AppliedDelta {
  key: string;
  subkey?: string;
  before: number;
  after: number;
  delta?: number;
  value?: number;
  reason?: string;
  dropped?: boolean;
  warning?: string;
}
