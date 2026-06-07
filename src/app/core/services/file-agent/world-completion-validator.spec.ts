import { describe, expect, it, vi } from 'vitest';
import { WorldCompletionValidator, WorldCompletionValidatorConfig } from './world-completion-validator';

// "0.Stats.yaml" is the en-locale stats ledger filename, so isStatsYamlFilename
// recognises it. Samples mirror the tool-executor guard spec.
const STATS_FILE = '0.Stats.yaml';
const VALID_STATS = 'stats:\n  hp:\n    value: 100\n';
const BROKEN_STATS = 'stats: [unclosed';
const PLACEHOLDER = 'To be filled in by the world generator';

function makeValidator(files: Record<string, string>, config: Partial<WorldCompletionValidatorConfig> = {}) {
  const map = new Map(Object.entries(files));
  const validator = new WorldCompletionValidator(() => map, {
    placeholders: [PLACEHOLDER],
    retryMessage: (remaining) => `remaining: ${remaining.join(',')}`,
    ...config,
  });
  return { validator, map };
}

describe('WorldCompletionValidator', () => {
  it('passes when no placeholders remain and stats are not required', () => {
    const { validator } = makeValidator({ 'a.md': 'done' });
    expect(validator.validate()).toEqual({ valid: true, errorMessage: '' });
    expect(validator.isCompleted).toBe(true);
  });

  it('ignores the stats ledger when includeStats is off', () => {
    const { validator } = makeValidator({ 'a.md': 'done' }, { includeStats: false });
    expect(validator.validate().valid).toBe(true);
  });

  it('fails with retryMessage while any file still has a placeholder', () => {
    const { validator } = makeValidator({ 'a.md': PLACEHOLDER, 'b.md': 'done' });
    expect(validator.validate()).toEqual({ valid: false, errorMessage: 'remaining: a.md' });
    expect(validator.isCompleted).toBe(false);
  });

  it('passes when includeStats is on and the stats YAML parses cleanly', () => {
    const { validator } = makeValidator(
      { 'a.md': 'done', [STATS_FILE]: VALID_STATS },
      { includeStats: true, statsErrorMessage: () => 'should not be used' }
    );
    expect(validator.validate().valid).toBe(true);
  });

  it('fails when includeStats is on and the stats YAML has a syntax error, passing the error to statsErrorMessage', () => {
    const statsErrorMessage = vi.fn((e: string) => `stats broke: ${e}`);
    const { validator } = makeValidator(
      { 'a.md': 'done', [STATS_FILE]: BROKEN_STATS },
      { includeStats: true, statsErrorMessage }
    );
    const r = validator.validate();
    expect(r.valid).toBe(false);
    expect(r.errorMessage).toMatch(/^stats broke: /);
    expect(statsErrorMessage).toHaveBeenCalledTimes(1);
    expect(statsErrorMessage.mock.calls[0][0]).not.toBe('');
    expect(validator.isCompleted).toBe(false);
  });

  it('fails when includeStats is on but the stats YAML is absent, passing an empty error string', () => {
    const statsErrorMessage = vi.fn((e: string) => `missing: ${e}`);
    const { validator } = makeValidator({ 'a.md': 'done' }, { includeStats: true, statsErrorMessage });
    const r = validator.validate();
    expect(r.valid).toBe(false);
    expect(statsErrorMessage).toHaveBeenCalledWith('');
  });

  it('short-circuits on placeholders before running the stats leg', () => {
    const statsErrorMessage = vi.fn((e: string) => e);
    const { validator } = makeValidator(
      { 'a.md': PLACEHOLDER, [STATS_FILE]: BROKEN_STATS },
      { includeStats: true, statsErrorMessage }
    );
    const r = validator.validate();
    expect(r.errorMessage).toBe('remaining: a.md');
    expect(statsErrorMessage).not.toHaveBeenCalled();
  });

  it('latches completion — a later regression does not re-open a validated world', () => {
    const { validator, map } = makeValidator({ 'a.md': 'done' });
    expect(validator.validate().valid).toBe(true);
    map.set('a.md', PLACEHOLDER);
    expect(validator.validate().valid).toBe(true);
  });
});
