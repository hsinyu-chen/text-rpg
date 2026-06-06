import { describe, expect, it } from 'vitest';
import { hasStatsYamlFile, priorStatDeltaLists } from './stats-opt-in.util';
import { EN_US_LOCALE } from '../../constants/locales/en';
import { ZH_TW_LOCALE } from '../../constants/locales/zh-tw';
import { ChatMessage } from '../../models/types';

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

describe('priorStatDeltaLists', () => {
    const msg = (m: Partial<ChatMessage>): ChatMessage =>
        ({ id: 'm', role: 'model', content: '', ...m }) as ChatMessage;

    it('includes a message toggled ref-only then back to active (isManualRefOnly true, isRefOnly false)', () => {
        const messages = [
            msg({ isRefOnly: false, isManualRefOnly: true, stat_delta: [{ key: 'hp', delta: -3 }] }),
        ];
        expect(priorStatDeltaLists(messages)).toEqual([[{ key: 'hp', delta: -3 }]]);
    });

    it('excludes a genuinely ref-only message', () => {
        const messages = [
            msg({ isRefOnly: true, stat_delta: [{ key: 'hp', delta: -3 }] }),
        ];
        expect(priorStatDeltaLists(messages)).toEqual([]);
    });

    it('excludes user-role messages', () => {
        const messages = [
            msg({ role: 'user', stat_delta: [{ key: 'hp', delta: -3 }] }),
        ];
        expect(priorStatDeltaLists(messages)).toEqual([]);
    });

    it('yields an empty list for an active model message with no stat_delta', () => {
        const messages = [msg({})];
        expect(priorStatDeltaLists(messages)).toEqual([[]]);
    });

    it('preserves per-message lists in chronological order across mixed messages', () => {
        const messages = [
            msg({ stat_delta: [{ key: 'hp', delta: -1 }] }),
            msg({ isRefOnly: true, stat_delta: [{ key: 'hp', delta: 99 }] }),
            msg({ role: 'user' }),
            msg({ isManualRefOnly: true, stat_delta: [{ key: 'mp', delta: 2 }] }),
        ];
        expect(priorStatDeltaLists(messages)).toEqual([
            [{ key: 'hp', delta: -1 }],
            [{ key: 'mp', delta: 2 }],
        ]);
    });
});
