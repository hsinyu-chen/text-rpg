import { describe, expect, it } from 'vitest';
import { carryForwardStats } from './session.service';
import { LOCALES } from '../constants/locales';
import { ChatMessage } from '../models/types';
import { buildStatBaseline, parseStats } from './stats/stats-yaml.util';
import { computeCurrent } from './stats/stat-ledger.service';
import { priorStatDeltaLists } from './stats/stats-opt-in.util';

const STATS_FILENAME = LOCALES['English'].optionalFilenames.STATS_YAML;

const STATS_YAML = `
stats:
  hp:
    type: scalar
    min: 0
    max: 100
    value: 80
  affinity:
    type: map
    min: 0
    max: 100
    allow_new_item: true
    value:
      王大福: 50
`;

function modelMsg(id: string, stat_delta: ChatMessage['stat_delta'], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'model', content: '', stat_delta, ...extra };
}

describe('carryForwardStats', () => {
  it('rewrites a stats Book\'s baseline to the closing fold so a fresh chat resumes from it', () => {
    const messages: ChatMessage[] = [
      modelMsg('m1', [{ key: 'hp', delta: -15 }]),
      modelMsg('m2', [{ key: 'affinity', subkey: '王大福', delta: 10 }]),
    ];
    const files = [{ name: STATS_FILENAME, content: STATS_YAML }];

    const { files: carried, malformed } = carryForwardStats(files, messages);
    expect(malformed).toBe(false);
    const { parsed } = parseStats(carried[0].content);

    // The next act starts with an empty chat, so its baseline IS the carried YAML.
    const resumed = computeCurrent(parsed, buildStatBaseline(parsed), []);
    const expected = computeCurrent(
      parseStats(STATS_YAML).parsed,
      buildStatBaseline(parseStats(STATS_YAML).parsed),
      priorStatDeltaLists(messages),
    );
    expect(resumed).toEqual(expected);
    expect(parsed.stats['hp'].value).toBe(65);
    expect(parsed.stats['affinity'].value).toEqual({ 王大福: 60 });
  });

  it('returns a new array without mutating the source file entries', () => {
    const files = [{ name: STATS_FILENAME, content: STATS_YAML }];
    const { files: carried } = carryForwardStats(files, [modelMsg('m1', [{ key: 'hp', delta: -5 }])]);
    expect(carried).not.toBe(files);
    expect(files[0].content).toBe(STATS_YAML);
  });

  it('leaves a non-stats Book untouched (no stats YAML present)', () => {
    const files = [{ name: 'world.md', content: '# World' }, { name: 'chars.md', content: '# Cast' }];
    const { files: carried, malformed } = carryForwardStats(files, [modelMsg('m1', [{ key: 'hp', delta: -5 }])]);
    expect(malformed).toBe(false);
    expect(carried).toEqual(files);
  });

  it('degrades on a syntactically-broken stats YAML: carries it verbatim, flags malformed, never throws', () => {
    const broken = 'stats:\n  hp: [unclosed';
    const files = [{ name: STATS_FILENAME, content: broken }];

    const run = () => carryForwardStats(files, [modelMsg('m1', [{ key: 'hp', delta: -5 }])]);
    expect(run).not.toThrow();

    const { files: carried, malformed } = run();
    expect(malformed).toBe(true);
    expect(carried[0].content).toBe(broken);
  });
});
