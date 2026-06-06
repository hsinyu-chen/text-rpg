import { describe, expect, it } from 'vitest';
import { validateStatsYaml } from './stats-validation.util';

describe('validateStatsYaml', () => {
  it('reports no syntax error and no warnings for a clean ledger', () => {
    const r = validateStatsYaml('stats:\n  hp:\n    value: 100\n    min: 0\n    max: 100\n');
    expect(r.syntaxError).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it('reports a genuine YAML syntax error without warnings', () => {
    const r = validateStatsYaml('key: [unclosed');
    expect(r.syntaxError).not.toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it('collects recoverable parse warnings (invalid stat key dropped)', () => {
    const r = validateStatsYaml('stats:\n  "has space":\n    value: 1\n');
    expect(r.syntaxError).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('dry-compiles event conditions and warns on a malformed one', () => {
    const yaml = [
      'stats:',
      '  hp:',
      '    value: 100',
      '    min: 0',
      '    max: 100',
      'events:',
      '  - condition: "hp.value <<< 0"',
      '    type: level',
      '    trigger: boom',
    ].join('\n');
    const r = validateStatsYaml(yaml);
    expect(r.syntaxError).toBeNull();
    expect(r.warnings.some(w => w.includes('compile'))).toBe(true);
  });

  it('warns when an event condition references an undeclared stat (throws at dry-eval)', () => {
    const yaml = [
      'stats:',
      '  hp:',
      '    value: 100',
      'events:',
      '  - condition: "mana.value < 0"',
      '    type: level',
      '    trigger: boom',
    ].join('\n');
    const r = validateStatsYaml(yaml);
    expect(r.syntaxError).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
