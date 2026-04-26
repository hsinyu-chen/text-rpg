export interface WorldCompletionValidatorConfig {
  /** Substrings that indicate an unfilled placeholder (e.g. '由世界生成器填入'). */
  placeholders: string[];
  /**
   * Message injected back into the agent conversation when validation fails.
   * Receives the list of filenames that still contain placeholders.
   */
  retryMessage: (remainingFiles: string[]) => string;
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

    const remaining: string[] = [];
    for (const [filename, content] of this.getFiles()) {
      if (this.config.placeholders.some(ph => content.includes(ph))) {
        remaining.push(filename);
      }
    }

    if (remaining.length === 0) {
      this._completed = true;
      return { valid: true, errorMessage: '' };
    }

    return { valid: false, errorMessage: this.config.retryMessage(remaining) };
  }
}
