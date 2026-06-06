import { parse } from 'yaml';
import { ParsedStats, StatDefinition, StatEvent, StatValues } from '../../models/stats.types';

/**
 * The starting values for a fold: each stat's declared `value` (a scalar number
 * or a map of subkey -> number). Shared by the engine's per-turn snapshot and
 * any display-side re-fold so both fold off the identical baseline.
 */
export function buildStatBaseline(parsed: ParsedStats): StatValues {
  return Object.fromEntries(Object.entries(parsed.stats).map(([key, def]) => [key, def.value]));
}

/**
 * Lenient parser for the stats-definition YAML block.
 *
 * Tolerant by design: a stats block authored (or LLM-generated) with a missing
 * section, a non-object stat entry, or an `events` field that isn't a list must
 * still yield a usable {@link ParsedStats} rather than abort the turn. Only a
 * genuine YAML syntax error propagates (the `yaml` parser throws) — the caller
 * decides how to surface that. All recoverable problems are dropped and noted in
 * `warnings` (returned alongside the result so they're unit-testable).
 */
export function parseStats(text: string): { parsed: ParsedStats; warnings: string[] } {
  const warnings: string[] = [];
  const empty: ParsedStats = { stats: {}, rules: '', events: [] };

  const root = parse(text);
  if (!isPlainObject(root)) {
    if (root != null) warnings.push('Top-level stats document is not a mapping; ignored.');
    return { parsed: empty, warnings };
  }

  return {
    parsed: {
      stats: parseStatsSection(root['stats'], warnings),
      rules: typeof root['rules'] === 'string' ? root['rules'] : '',
      events: parseEventsSection(root['events'], warnings),
    },
    warnings,
  };
}

function parseStatsSection(raw: unknown, warnings: string[]): Record<string, StatDefinition> {
  const out: Record<string, StatDefinition> = {};
  if (raw == null) return out;
  if (!isPlainObject(raw)) {
    warnings.push('`stats` is not a mapping; ignored.');
    return out;
  }

  for (const [key, entry] of Object.entries(raw)) {
    if (!isValidStatKey(key)) {
      warnings.push(`Dropped stat with invalid key "${key}" (must be a usable identifier).`);
      continue;
    }
    const def = parseStatDefinition(key, entry, warnings);
    if (def) out[key] = def;
  }
  return out;
}

function parseStatDefinition(
  key: string,
  entry: unknown,
  warnings: string[],
): StatDefinition | null {
  if (!isPlainObject(entry)) {
    warnings.push(`Dropped stat "${key}": definition is not a mapping.`);
    return null;
  }

  const value = entry['value'];
  const declaredType = entry['type'];
  const type: 'scalar' | 'map' =
    declaredType === 'scalar' || declaredType === 'map'
      ? declaredType
      : isPlainObject(value)
        ? 'map'
        : 'scalar';

  const def: StatDefinition = {
    type,
    value: type === 'map' ? coerceMapValue(value) : coerceScalarValue(value),
    allow_new_item: entry['allow_new_item'] === true,
  };

  if (isFiniteNumber(entry['min'])) def.min = entry['min'];
  if (isFiniteNumber(entry['max'])) def.max = entry['max'];
  if (typeof entry['desc'] === 'string') def.desc = entry['desc'];
  if (typeof entry['new_item_rule'] === 'string') def.new_item_rule = entry['new_item_rule'];
  // Kept as a raw string — CSS-color validity is checked at render (CSS.supports),
  // not here, so the parser stays environment-agnostic.
  if (typeof entry['color'] === 'string' && entry['color'].trim() !== '') def.color = entry['color'].trim();

  return def;
}

function coerceScalarValue(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

function coerceMapValue(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isPlainObject(value)) {
    for (const [subkey, sub] of Object.entries(value)) {
      if (isFiniteNumber(sub)) out[subkey] = sub;
    }
  }
  return out;
}

function parseEventsSection(raw: unknown, warnings: string[]): StatEvent[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    warnings.push('`events` is not a list; ignored.');
    return [];
  }

  const out: StatEvent[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) {
      warnings.push('Dropped event: entry is not a mapping.');
      continue;
    }
    const condition = entry['condition'];
    const trigger = entry['trigger'];
    const type = entry['type'] === 'edge' ? 'edge' : 'level';
    if (typeof condition !== 'string' || typeof trigger !== 'string') {
      warnings.push('Dropped event: missing string `condition`/`trigger`.');
      continue;
    }
    out.push({ condition, type, trigger });
  }
  return out;
}

// A `new Function` param accepts far more than one identifier — `a, b` is two
// params, `x = (()=>{...})()` is a default-value IIFE that runs when called with
// fewer args. So validation can't lean on the engine accepting the param; it must
// prove the key is exactly ONE identifier and not a reserved word, by pure means.
const STAT_KEY_RE = /^[\p{ID_Start}_$][\p{ID_Continue}_$‌‍]*$/u;

const RESERVED_STAT_KEYS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'let', 'static', 'yield', 'await', 'implements', 'interface', 'package',
  'private', 'protected', 'public', 'arguments', 'eval',
]);

/**
 * A stat key is used verbatim as a `new Function` parameter name when compiling
 * event conditions, so it must be a single legal JS identifier and not a reserved
 * word. CJK letters are allowed (JS identifiers permit them); anything containing
 * a space, comma, operator, paren, dot, or a leading digit is rejected — which is
 * what keeps a multi-declarator / default-param injection from passing.
 */
export function isValidStatKey(key: string): boolean {
  if (!key) return false;
  if (!STAT_KEY_RE.test(key)) return false;
  return !RESERVED_STAT_KEYS.has(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// YAML `.nan`/`.inf`/`-.inf` parse to JS NaN/Infinity, which are `typeof "number"`
// yet poison clamp(); a finite check keeps them out of values and bounds alike.
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
