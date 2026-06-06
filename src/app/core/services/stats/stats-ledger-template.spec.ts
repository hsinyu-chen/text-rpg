import { describe, expect, it } from 'vitest';
import { LOCALES } from '../../constants/locales';
import { validateStatsYaml } from './stats-validation.util';
import { parseStats } from './stats-yaml.util';

// The on-ramp scaffolds locale.statsLedgerTemplate as a real stats file, so it
// must satisfy the very save guard it will be edited under: clean parse, zero
// warnings, and the starter stats/events it advertises.
describe('statsLedgerTemplate (per-locale stats on-ramp starter)', () => {
  for (const [name, locale] of Object.entries(LOCALES)) {
    describe(name, () => {
      it('validates with no syntax error and no warnings', () => {
        const result = validateStatsYaml(locale.statsLedgerTemplate);
        expect(result.syntaxError).toBeNull();
        expect(result.warnings).toEqual([]);
      });

      it('declares the advertised starter stats and event', () => {
        const { parsed } = parseStats(locale.statsLedgerTemplate);
        expect(parsed.stats['hp']?.type).toBe('scalar');
        expect(parsed.stats['hp']?.max).toBe(100);
        expect(parsed.stats['affinity']?.type).toBe('map');
        expect(parsed.stats['affinity']?.allow_new_item).toBe(true);
        expect(parsed.events.length).toBeGreaterThan(0);
      });
    });
  }
});
