import { parse } from 'yaml';
import { ParsedStats, StatDefinition, StatEvent } from '../../models/stats.types';

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

  if (typeof entry['min'] === 'number') def.min = entry['min'];
  if (typeof entry['max'] === 'number') def.max = entry['max'];
  if (typeof entry['desc'] === 'string') def.desc = entry['desc'];
  if (typeof entry['new_item_rule'] === 'string') def.new_item_rule = entry['new_item_rule'];

  return def;
}

function coerceScalarValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function coerceMapValue(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isPlainObject(value)) {
    for (const [subkey, sub] of Object.entries(value)) {
      if (typeof sub === 'number') out[subkey] = sub;
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

/**
 * A stat key is used verbatim as a `new Function` parameter name when compiling
 * event conditions, so it must be a legal JS identifier. CJK letters are allowed
 * (JS identifiers permit them); spaces, symbols, and a leading digit are not.
 */
export function isValidStatKey(key: string): boolean {
  if (!key) return false;
  try {
    // The identifier-shape check the runtime itself enforces — cheaper to
    // maintain than a hand-rolled Unicode regex that has to track ID_Start.
    new Function(key, 'return 0;');
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
