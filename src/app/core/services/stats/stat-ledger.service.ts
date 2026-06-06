import { Injectable } from '@angular/core';
import {
  AppliedDelta,
  ParsedStats,
  StatBounds,
  StatChange,
  StatDefinition,
  StatEvent,
  StatState,
  StatValues,
} from '../../models/stats.types';
import { isValidStatKey } from './stats-yaml.util';

/** Clamp `n` to `[min, max]`; either bound is optional (open on that side). */
export function clamp(n: number, min?: number, max?: number): number {
  let out = n;
  if (typeof min === 'number') out = Math.max(out, min);
  if (typeof max === 'number') out = Math.min(out, max);
  return out;
}

/**
 * Apply an ordered list of {@link StatChange}s to a baseline, producing the new
 * values, the live bounds, and an audit trail. Pure: `baseline` /
 * `baselineBounds` are deep-copied and never mutated.
 *
 * Changes are processed strictly in order — the caller is responsible for
 * passing only surviving/truncated steps, already flattened. Value changes clamp
 * to the LIVE bounds (declared `min`/`max` folded with any earlier `field:"min"`
 * / `field:"max"` changes in this same sequence), AFTER every change, so a value
 * that transiently exceeds a bound mid-sequence is pinned at each step (no
 * remembered overflow). A bound change re-clamps the stat's current value(s) to
 * the new range, so LOWERING a max below the current value pulls it down (debuff
 * caps) while RAISING a max only opens headroom. `baselineBounds` seeds the live
 * bounds so an incremental fold continues from a prior turn's bounds.
 */
export function fold(
  stats: ParsedStats,
  baseline: StatValues,
  changes: StatChange[],
  baselineBounds: StatBounds = {},
): { values: StatValues; bounds: StatBounds; applied: AppliedDelta[] } {
  const values: StatValues = deepCopyValues(baseline);
  const bounds: StatBounds = deepCopyBounds(baselineBounds);
  const applied: AppliedDelta[] = [];

  for (const change of changes) {
    applied.push(applyChange(stats, values, bounds, change));
  }

  return { values, bounds, applied };
}

function applyChange(
  stats: ParsedStats,
  values: StatValues,
  bounds: StatBounds,
  change: StatChange,
): AppliedDelta {
  const { key, subkey, field } = change;
  const def = stats.stats[key];

  if (!def) {
    return drop(change, 0, `Unknown stat "${key}".`);
  }

  if (field === 'min' || field === 'max') {
    return applyBoundChange(def, values, bounds, change, field);
  }

  const eff = boundsFor(def, bounds, key);
  if (subkey === undefined) {
    if (def.type === 'map') {
      return drop(change, 0, `Map stat "${key}" change needs a subkey.`);
    }
    return applyScalar(eff, values, change);
  }

  if (def.type !== 'map') {
    return drop(change, 0, `Stat "${key}" is scalar but a subkey "${subkey}" was given.`);
  }

  return applyMapSubkey(def, eff, values, change);
}

function applyScalar(eff: Bounds, values: StatValues, change: StatChange): AppliedDelta {
  const { key, delta, value, reason } = change;
  const before = typeof values[key] === 'number' ? (values[key] as number) : 0;

  // Safety net: a scalar must accumulate via delta. An absolute `value` on an
  // existing scalar would clobber the running total, so ignore it.
  if (value !== undefined && delta === undefined) {
    return drop(
      change,
      before,
      `Scalar "${key}" received absolute value; ignored to protect accumulation.`,
    );
  }

  const after = clamp(before + (delta ?? 0), eff.min, eff.max);
  values[key] = after;
  return { key, before, after, delta, reason };
}

function applyMapSubkey(
  def: StatDefinition,
  eff: Bounds,
  values: StatValues,
  change: StatChange,
): AppliedDelta {
  const { key, subkey, delta, value, reason } = change;
  const sub = subkey as string;
  // Read the existing map without materializing one: a dropped change must not
  // leave a spurious empty map (or clobber a non-object) behind in `values`.
  const current = values[key];
  const map = typeof current === 'object' && current !== null ? current : null;
  const exists = map ? Object.prototype.hasOwnProperty.call(map, sub) : false;
  const before = map && exists ? map[sub] : 0;

  if (exists && map) {
    // Safety net: protect an existing subkey's running total from an absolute set.
    if (value !== undefined && delta === undefined) {
      return drop(
        change,
        before,
        `Subkey "${key}.${sub}" received absolute value; ignored to protect accumulation.`,
      );
    }
    const after = clamp(before + (delta ?? 0), eff.min, eff.max);
    map[sub] = after;
    return { key, subkey: sub, before, after, delta, reason };
  }

  // New subkey — only authorized when the stat opts in.
  if (!def.allow_new_item) {
    return drop(change, before, `New subkey "${key}.${sub}" not allowed (allow_new_item is false).`);
  }

  // Authorized creation. `value` is the intended absolute initial amount; a
  // `delta` on a not-yet-existing subkey is tolerated as its initial value.
  const targetMap = map ?? ensureMap(values, key);
  if (value !== undefined) {
    const after = clamp(value, eff.min, eff.max);
    targetMap[sub] = after;
    return { key, subkey: sub, before, after, value, reason };
  }

  const after = clamp(delta ?? 0, eff.min, eff.max);
  targetMap[sub] = after;
  return {
    key,
    subkey: sub,
    before,
    after,
    delta,
    reason,
    warning: `New subkey "${key}.${sub}" created from delta as its initial value.`,
  };
}

/** Live bounds for one stat (each side optional/open). */
interface Bounds { min?: number; max?: number }

/**
 * Resolve an overlay entry over the declared defaults, PER SIDE: each bound is
 * the overlay's when set, else the definition's. The single definition of
 * "overlay-over-def" — both the read path ({@link boundsFor}) and the write path
 * ({@link ensureBounds}) go through it, so a half-open overlay can never drop a
 * declared bound at any call site.
 */
function resolveBounds(def: StatDefinition, entry: Bounds | undefined): Bounds {
  return {
    min: entry?.min !== undefined ? entry.min : def.min,
    max: entry?.max !== undefined ? entry.max : def.max,
  };
}

/** Effective (read-only) bounds for `key`: the overlay merged over the defaults. */
function boundsFor(def: StatDefinition, bounds: StatBounds, key: string): Bounds {
  return resolveBounds(def, bounds[key]);
}

/**
 * Resolve and STORE `key`'s overlay entry as fully populated, returning it. A
 * later `b[field] = next` then mutates an absolute current bound, and any
 * re-clamp through the returned object sees BOTH sides — never a half-open
 * overlay that would silently treat a declared bound as open.
 */
function ensureBounds(def: StatDefinition, bounds: StatBounds, key: string): Bounds {
  const b = resolveBounds(def, bounds[key]);
  bounds[key] = b;
  return b;
}

/** Re-clamp a stat's current value(s) into `b` — scalar in place, every map subkey. */
function reclampStat(values: StatValues, b: Bounds, key: string): void {
  const v = values[key];
  if (typeof v === 'number') {
    values[key] = clamp(v, b.min, b.max);
  } else if (v && typeof v === 'object' && !Array.isArray(v)) {
    const map = v as Record<string, number>;
    for (const sub of Object.keys(map)) map[sub] = clamp(map[sub], b.min, b.max);
  }
}

/**
 * Apply a `field:"min"` / `field:"max"` change: `value` sets the bound
 * absolutely, `delta` shifts the current bound. A delta on an open (unset) bound
 * is dropped — an open side must be introduced with an absolute `value`. A change
 * that would invert the range (min above max / max below min) is dropped so
 * {@link clamp} never sees a contradictory `[min, max]`. On success the stat's
 * current value(s) are re-clamped to the new range. Stat-level — `subkey` is
 * ignored.
 */
function applyBoundChange(
  def: StatDefinition,
  values: StatValues,
  bounds: StatBounds,
  change: StatChange,
  field: 'min' | 'max',
): AppliedDelta {
  const { key, delta, value, reason } = change;
  const eff = boundsFor(def, bounds, key);
  const before = eff[field];

  let next: number;
  if (value !== undefined) {
    next = value;
  } else if (delta !== undefined) {
    if (before === undefined) {
      return dropBound(
        change,
        field,
        before,
        `Bound "${key}.${field}" is open; introduce it with an absolute value, not a delta.`,
      );
    }
    next = before + delta;
  } else {
    return dropBound(change, field, before, `Bound change "${key}.${field}" has neither delta nor value.`);
  }

  const other = field === 'min' ? eff.max : eff.min;
  if (other !== undefined && (field === 'min' ? next > other : next < other)) {
    return dropBound(
      change,
      field,
      before,
      `Bound change "${key}.${field}"=${next} would invert the range (other bound ${other}); ignored.`,
    );
  }

  const b = ensureBounds(def, bounds, key);
  b[field] = next;
  reclampStat(values, b, key);
  // Record only the field that decided `next` (value wins when both are given),
  // mirroring the value path's audit — so the trail never shows an ignored input.
  // before is undefined only when introducing a previously-open bound via value;
  // record `next` so the audit line reads as a no-op delta rather than NaN.
  const audit: AppliedDelta = { key, field, before: before ?? next, after: next, reason };
  if (value !== undefined) audit.value = value;
  else audit.delta = delta;
  return audit;
}

function dropBound(
  change: StatChange,
  field: 'min' | 'max',
  before: number | undefined,
  warning: string,
): AppliedDelta {
  const at = before ?? 0;
  return {
    key: change.key,
    field,
    before: at,
    after: at,
    delta: change.delta,
    value: change.value,
    reason: change.reason,
    dropped: true,
    warning,
  };
}

function drop(change: StatChange, before: number, warning: string): AppliedDelta {
  return {
    key: change.key,
    subkey: change.subkey,
    before,
    after: before,
    delta: change.delta,
    value: change.value,
    reason: change.reason,
    dropped: true,
    warning,
  };
}

function ensureMap(values: StatValues, key: string): Record<string, number> {
  const current = values[key];
  if (typeof current === 'object' && current !== null) return current;
  const fresh: Record<string, number> = {};
  values[key] = fresh;
  return fresh;
}

function deepCopyValues(values: StatValues): StatValues {
  const out: StatValues = {};
  for (const [key, val] of Object.entries(values)) {
    out[key] = typeof val === 'object' && val !== null ? { ...val } : val;
  }
  return out;
}

function deepCopyBounds(bounds: StatBounds): StatBounds {
  const out: StatBounds = {};
  for (const [key, b] of Object.entries(bounds)) {
    out[key] = { ...b };
  }
  return out;
}

/**
 * Flatten chronological per-message delta lists and fold them onto the baseline,
 * returning the resolved {@link StatState} (live values + live bounds — the
 * latter reflecting every `field:"min"` / `field:"max"` change across history).
 * `deltaLists` is each message's `stat_delta` in order — kept decoupled from
 * ChatMessage on purpose so the ledger stays free of the chat model.
 */
export function computeCurrent(
  stats: ParsedStats,
  baseline: StatValues,
  deltaLists: StatChange[][],
): StatState {
  const { values, bounds } = fold(stats, baseline, deltaLists.flat());
  return { values, bounds };
}

/**
 * Render resolved {@link StatValues} as a compact, model-readable block — one
 * line per stat in declaration order, scalars as `key: n` and maps as
 * `key: { sub: n, sub2: n }` (empty map as `key: {}`). A stat present in the
 * definition but absent from `values` falls back to its declared baseline shape
 * (0 / {}), so the block always covers every declared stat. Returns '' when no
 * stats are declared. Pure; reads only the definition's key set + types.
 */
export function renderStatValues(stats: ParsedStats, values: StatValues): string {
  const lines: string[] = [];
  for (const [key, def] of Object.entries(stats.stats)) {
    const raw = values[key];
    if (def.type === 'map') {
      const map =
        typeof raw === 'object' && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, number>)
          : {};
      const entries = Object.entries(map).map(([sub, n]) => `${sub}: ${n}`);
      lines.push(`${key}: { ${entries.join(', ')} }`);
    } else {
      lines.push(`${key}: ${typeof raw === 'number' ? raw : 0}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render each stat's authored DEFINITION (not its live values) as a compact,
 * deterministic block — one line per stat in declaration order, so the resolver
 * sees what each stat tracks without the author re-describing it in `rules`.
 *
 * Line shape: `<key> — <desc> (<type>[, <range>][, new items allowed])`, where
 * `<range>` is `min–max` / `≥min` / `≤max` (omitted when neither bound is set),
 * the ` — <desc>` segment is omitted when the stat has no `desc`, and
 * `, new items allowed` is appended only for map stats that opt into
 * `allow_new_item`. The optional `bounds` overlay makes the range reflect the
 * LIVE bounds (after `field:"min"` / `field:"max"` changes); omit it for the
 * declared range. Returns '' when no stats are declared. Pure.
 */
export function renderStatDefinitions(stats: ParsedStats, bounds: StatBounds = {}): string {
  const lines: string[] = [];
  for (const [key, def] of Object.entries(stats.stats)) {
    const attrs: string[] = [def.type];
    const range = renderRangeFor(def, bounds, key);
    if (range) attrs.push(range);
    if (def.type === 'map' && def.allow_new_item) attrs.push('new items allowed');
    const desc = def.desc ? ` — ${def.desc}` : '';
    lines.push(`${key}${desc} (${attrs.join(', ')})`);
  }
  return lines.join('\n');
}

function renderRangeFor(def: StatDefinition, bounds: StatBounds, key: string): string {
  const eff = boundsFor(def, bounds, key);
  return renderRange(eff.min, eff.max);
}

function renderRange(min?: number, max?: number): string {
  if (typeof min === 'number' && typeof max === 'number') return `${min}–${max}`;
  if (typeof min === 'number') return `≥${min}`;
  if (typeof max === 'number') return `≤${max}`;
  return '';
}

/** The per-stat named argument exposed to a compiled event condition. */
interface StatArg {
  value: number | Record<string, number>;
  min?: number;
  max?: number;
}

type CompiledCondition = (...args: StatArg[]) => unknown;

/**
 * Build the ordered named-argument list (param names + matching values) handed
 * to a compiled condition. Same stat order is used for both prev and curr
 * evaluation so a single compiled function applies to both. Each arg's `min`/
 * `max` carry the LIVE bounds from the state, so a condition reading `hp.max`
 * sees the bound after any `field:"max"` change rather than the declared one.
 */
function buildConditionArgs(
  stats: ParsedStats,
  state: StatState,
): { names: string[]; args: StatArg[] } {
  const names: string[] = [];
  const args: StatArg[] = [];
  for (const [key, def] of Object.entries(stats.stats)) {
    names.push(key);
    const raw = state.values[key];
    const eff = boundsFor(def, state.bounds, key);
    const fallback = def.type === 'map' ? {} : 0;
    // A condition is author-trusted but still untrusted to mutate: pass a shallow
    // clone of a map so `affinity.value['x'] = 999` can't write back into the
    // ledger. Scalars are numbers (immutable) — no clone needed.
    const value =
      typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? { ...raw }
        : typeof raw === 'number'
          ? raw
          : fallback;
    args.push({ value, min: eff.min, max: eff.max });
  }
  return { names, args };
}

/**
 * Evaluate stat events against a prev/curr value pair, returning the triggered
 * `trigger` strings in event order.
 *
 * Each condition is compiled once (cached by its source string) into a function
 * whose parameters are the stat keys, each bound to a {@link StatArg} so a
 * condition reads `hp.value <= 0` or `affinity.value["王如花"] < 50`. `level`
 * events fire whenever the condition is truthy on curr; `edge` events fire only
 * on a false->true crossing (falsy on prev, truthy on curr). The prev/curr
 * {@link StatState}s each supply their own live bounds, so a condition over
 * `hp.max` sees the right bound on each side of a turn that changed it. A
 * condition that fails to compile (malformed source), carries a stat param name
 * that isn't a single legal identifier, or throws at runtime is treated as
 * not-triggered (the turn must never crash); the failure is pushed to `warnings`
 * when one is supplied, otherwise `console.warn`d so it's never silently swallowed.
 */
export function evaluateEvents(
  stats: ParsedStats,
  prevState: StatState,
  currState: StatState,
  events: StatEvent[],
  cache = new Map<string, CompiledCondition>(),
  warnings?: string[],
): string[] {
  const triggered: string[] = [];
  const prev = buildConditionArgs(stats, prevState);
  const curr = buildConditionArgs(stats, currState);

  for (const event of events) {
    let fn: CompiledCondition;
    try {
      fn = compileCondition(event.condition, prev.names, cache, warnings);
    } catch (err) {
      const message = `Event condition "${event.condition}" failed to compile: ${err instanceof Error ? err.message : String(err)}`;
      if (warnings) warnings.push(message);
      else console.warn(`[StatLedger] ${message}`);
      continue;
    }

    const currTruthy = safeEval(fn, curr.args, event.condition, warnings);
    if (!currTruthy) continue;

    if (event.type === 'level') {
      triggered.push(event.trigger);
      continue;
    }

    const prevTruthy = safeEval(fn, prev.args, event.condition, warnings);
    if (!prevTruthy) triggered.push(event.trigger);
  }

  return triggered;
}

const alwaysFalse: CompiledCondition = () => false;

function compileCondition(
  condition: string,
  paramNames: string[],
  cache: Map<string, CompiledCondition>,
  warnings?: string[],
): CompiledCondition {
  // The compiled fn bakes paramNames in as its formal parameters, so two stat
  // schemas sharing a condition string but differing in key set/order must not
  // share a cached fn — key on the signature too.
  const cacheKey = `${paramNames.join(',')}|${condition}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  // Defense-in-depth: paramNames are stat keys already validated by parseStats,
  // but `new Function` is the dangerous sink — re-prove every name is a single
  // legal identifier here so the security property is local to this call site.
  // A bad name (e.g. an injection like `a),{};return process//`) compiles to the
  // always-false fn instead of executing, keeping the guarantee independent of
  // every upstream caller having sanitized its keys.
  const badName = paramNames.find((name) => !isValidStatKey(name));
  if (badName !== undefined) {
    const message = `Event condition "${condition}" skipped: invalid stat param name "${badName}".`;
    if (warnings) warnings.push(message);
    else console.warn(`[StatLedger] ${message}`);
    cache.set(cacheKey, alwaysFalse);
    return alwaysFalse;
  }
  // v1 treats stat-event conditions as author-trusted content (same accepted
  // posture as post-processor.service.ts's `new Function`); a sandbox is deferred to v2.
  const fn = new Function(...paramNames, `return (${condition});`) as CompiledCondition;
  cache.set(cacheKey, fn);
  return fn;
}

function safeEval(
  fn: CompiledCondition,
  args: StatArg[],
  condition: string,
  warnings?: string[],
): boolean {
  try {
    return Boolean(fn(...args));
  } catch (err) {
    const message = `Event condition "${condition}" threw: ${err instanceof Error ? err.message : String(err)}`;
    if (warnings) warnings.push(message);
    else console.warn(`[StatLedger] ${message}`);
    return false;
  }
}

@Injectable({ providedIn: 'root' })
export class StatLedgerService {
  private readonly conditionCache = new Map<string, CompiledCondition>();

  clamp(n: number, min?: number, max?: number): number {
    return clamp(n, min, max);
  }

  fold(
    stats: ParsedStats,
    baseline: StatValues,
    changes: StatChange[],
    baselineBounds: StatBounds = {},
  ): { values: StatValues; bounds: StatBounds; applied: AppliedDelta[] } {
    return fold(stats, baseline, changes, baselineBounds);
  }

  computeCurrent(stats: ParsedStats, baseline: StatValues, deltaLists: StatChange[][]): StatState {
    return computeCurrent(stats, baseline, deltaLists);
  }

  renderStatValues(stats: ParsedStats, values: StatValues): string {
    return renderStatValues(stats, values);
  }

  renderStatDefinitions(stats: ParsedStats, bounds: StatBounds = {}): string {
    return renderStatDefinitions(stats, bounds);
  }

  evaluateEvents(
    stats: ParsedStats,
    prevState: StatState,
    currState: StatState,
    events: StatEvent[],
    warnings?: string[],
  ): string[] {
    return evaluateEvents(stats, prevState, currState, events, this.conditionCache, warnings);
  }
}
