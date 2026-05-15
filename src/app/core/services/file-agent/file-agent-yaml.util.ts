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
  return stringify(value, { lineWidth: 0, indent: 2 });
}
