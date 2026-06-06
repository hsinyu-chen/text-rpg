import { describe, expect, it } from 'vitest';
import { hasStatsYamlFile } from './stats-opt-in.util';
import { EN_US_LOCALE } from '../../constants/locales/en';
import { ZH_TW_LOCALE } from '../../constants/locales/zh-tw';

describe('hasStatsYamlFile', () => {
    it('returns false for a Book with no stats ledger file', () => {
        const files = new Map<string, string>([
            [EN_US_LOCALE.coreFilenames.BASIC_SETTINGS, '...'],
            [EN_US_LOCALE.coreFilenames.INVENTORY, '...'],
        ]);
        expect(hasStatsYamlFile(files)).toBe(false);
    });

    it('returns true when the en-locale stats file is present', () => {
        const files = new Map<string, string>([
            [EN_US_LOCALE.optionalFilenames.STATS_YAML, 'stats: {}'],
        ]);
        expect(hasStatsYamlFile(files)).toBe(true);
    });

    it('returns true when the zh-tw-locale stats file is present (cross-locale detection)', () => {
        const files = new Map<string, string>([
            [ZH_TW_LOCALE.optionalFilenames.STATS_YAML, 'stats: {}'],
        ]);
        expect(hasStatsYamlFile(files)).toBe(true);
    });

    it('returns false for an empty Book', () => {
        expect(hasStatsYamlFile(new Map())).toBe(false);
    });
});
