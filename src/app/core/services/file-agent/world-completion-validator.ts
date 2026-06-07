import { isStatsYamlFilename } from '../stats/stats-opt-in.util';
import { validateStatsYaml } from '../stats/stats-validation.util';

export interface WorldCompletionValidatorConfig {
  /** Substrings that indicate an unfilled placeholder (e.g. '由世界生成器填入'). */
  placeholders: string[];
  /**
   * Message injected back into the agent conversation when validation fails.
   * Receives the list of filenames that still contain placeholders.
   */
  retryMessage: (remainingFiles: string[]) => string;
  /**
   * When true the world also opted into the numeric-stats ledger, so completion
   * additionally requires a stats YAML that exists and parses (a `syntaxError`
   * blocks; non-blocking warnings don't).
   */
  includeStats?: boolean;
  /**
   * Message injected when `includeStats` is set but the stats YAML is missing
   * or has a syntax error. Receives the syntax error (empty string when the
   * file is absent entirely). i18n stays at the call site.
   */
  statsErrorMessage?: (syntaxError: string) => string;
}

export class WorldCompletionValidator {
  private _completed = false;

  constructor(
    private readonly getFiles: () => Map<string, string>,
    private readonly config: WorldCompletionValidatorConfig
  ) {}

  get isCompleted(): boolean {
    return this._completed;
  }

  validate(): { valid: boolean; errorMessage: string } {
    if (this._completed) return { valid: true, errorMessage: '' };

    const files = this.getFiles();
    const remaining: string[] = [];
    for (const [filename, content] of files) {
      if (this.config.placeholders.some(ph => content.includes(ph))) {
        remaining.push(filename);
      }
    }

    if (remaining.length > 0) {
      return { valid: false, errorMessage: this.config.retryMessage(remaining) };
    }

    if (this.config.includeStats) {
      const statsResult = this.validateStats(files);
      if (statsResult) return statsResult;
    }

    this._completed = true;
    return { valid: true, errorMessage: '' };
  }

  /** The stats-ledger leg of completion — null when the ledger is acceptable. */
  private validateStats(files: Map<string, string>): { valid: boolean; errorMessage: string } | null {
    let statsContent: string | undefined;
    for (const [filename, content] of files) {
      if (isStatsYamlFilename(filename)) {
        statsContent = content;
        break;
      }
    }

    const fail = (syntaxError: string) => ({
      valid: false,
      errorMessage: this.config.statsErrorMessage?.(syntaxError) ?? syntaxError,
    });

    if (statsContent === undefined) return fail('');
    const { syntaxError } = validateStatsYaml(statsContent);
    return syntaxError ? fail(syntaxError) : null;
  }
}
