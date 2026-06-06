import { StatState } from '../../models/stats.types';
import { buildStatBaseline, parseStats } from './stats-yaml.util';
import { evaluateEvents } from './stat-ledger.service';

export interface StatsYamlValidation {
  /** A genuine YAML syntax error message, or null when the document parsed. */
  syntaxError: string | null;
  /**
   * Recoverable issues — `parseStats` warnings (dropped bad key / non-object
   * entry / …) PLUS event-condition failures found by dry-compiling each
   * condition. Empty when the ledger is clean.
   */
  warnings: string[];
}

/**
 * Validate edited stats-YAML content for the file editor's save path. A real
 * YAML syntax error (which `parseStats` throws on) is reported as `syntaxError`;
 * everything else degrades into `warnings`. The events are dry-compiled against
 * the declared baseline so a malformed `condition` or a bad stat key — which at
 * runtime would only no-op and `console.warn` — is surfaced at save time, when
 * the author can still fix it. Pure: evaluates nothing beyond compiling and a
 * single baseline-vs-baseline pass.
 *
 * The whole body is guarded: this gates the save, so an unexpected throw from
 * any step (parse, baseline build, event eval) must degrade to a `syntaxError`
 * the caller can surface — never crash the save itself.
 */
export function validateStatsYaml(content: string): StatsYamlValidation {
  try {
    const { parsed, warnings: parseWarnings } = parseStats(content);
    const warnings = [...parseWarnings];
    const baseline: StatState = { values: buildStatBaseline(parsed), bounds: {} };
    evaluateEvents(parsed, baseline, baseline, parsed.events, new Map(), warnings);
    return { syntaxError: null, warnings };
  } catch (err) {
    return { syntaxError: err instanceof Error ? err.message : String(err), warnings: [] };
  }
}
