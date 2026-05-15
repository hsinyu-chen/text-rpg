import { stringify } from 'yaml';

/**
 * Serializes a tool-call payload or tool-result envelope as YAML for the
 * JSON-mode tool-call channel and for the agent-console UI log. YAML keeps
 * the same shape as the JSON schema but drops `{}` / `""` / commas, which
 * accumulate noticeably across many small-model turns.
 *
 * `lineWidth: 0` disables flow-style auto-wrapping so multi-line strings stay
 * on contiguous lines (literal block `|` when appropriate). Default string
 * type is left to the parser so values containing YAML-significant
 * characters get quoted automatically.
 */
export function toAgentYaml(value: unknown): string {
  return stringify(value, { lineWidth: 0, indent: 2 });
}
