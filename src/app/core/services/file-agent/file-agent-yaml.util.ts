import { stringify } from 'yaml';

/**
 * Serializes a tool-call payload or tool-result envelope as YAML for the
 * agent-console UI log. The LLM-bound channel still uses minified JSON —
 * an empirical char-count comparison on a realistic chat-search payload
 * had YAML ~8 % larger than minified JSON, so the original token-savings
 * motivation didn't survive measurement and the LLM side was reverted.
 * What YAML still buys is a readable UI: indent-aligned keys, no `\"` /
 * `\\n` escapes, and a structure that scans without parsing.
 *
 * `lineWidth: 0` disables flow-style auto-wrapping so multi-line strings stay
 * on contiguous lines (literal block `|` when appropriate). Default string
 * type is left to the parser so values containing YAML-significant
 * characters get quoted automatically.
 */
export function toAgentYaml(value: unknown): string {
  // `yaml.stringify` (a) returns undefined when the input itself is undefined,
  // which would silently violate this util's `string` return type, and
  // (b) always appends a trailing newline that shows up as a blank line in the
  // `<pre>`-rendered log entry. Coalesce + trimEnd handles both at the boundary.
  // `aliasDuplicateObjects: false` keeps the output anchor/alias-free
  // (`&id` / `*id` markers). They save bytes when the same object is
  // referenced twice but make the log unreadable for anyone not fluent
  // in YAML — and the UI log is exactly where readability is the point.
  const yaml = stringify(value, { lineWidth: 0, indent: 2, aliasDuplicateObjects: false });
  return yaml ? yaml.trimEnd() : '';
}
