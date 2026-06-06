import { describe, expect, it, vi } from 'vitest';
import { ParsedStats, StatChange, StatEvent, StatValues } from '../../models/stats.types';
import {
  clamp,
  computeCurrent,
  evaluateEvents,
  fold,
  StatLedgerService,
} from './stat-ledger.service';

function scalarStats(overrides: Partial<ParsedStats['stats']> = {}): ParsedStats {
  return {
    stats: {
      hp: { type: 'scalar', min: 0, max: 100, value: 100 },
      ...overrides,
    },
    rules: '',
    events: [],
  };
}

function affinityStats(allowNew: boolean): ParsedStats {
  return {
    stats: {
      affinity: {
        type: 'map',
        min: 0,
        max: 100,
        value: { 王大福: 50 },
        allow_new_item: allowNew,
      },
    },
    rules: '',
    events: [],
  };
}

describe('clamp', () => {
  it('clamps to both bounds', () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-5, 0, 100)).toBe(0);
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('treats missing bounds as open', () => {
    expect(clamp(150, 0)).toBe(150);
    expect(clamp(-5, undefined, 100)).toBe(-5);
    expect(clamp(42)).toBe(42);
  });
});

describe('fold', () => {
  it('applies a change sequence to the correct values', () => {
    const stats = scalarStats();
    const baseline: StatValues = { hp: 100 };
    const { values } = fold(stats, baseline, [
      { key: 'hp', delta: -30 },
      { key: 'hp', delta: 10 },
    ]);
    expect(values['hp']).toBe(80);
  });

  it('leaves baseline unchanged for empty changes', () => {
    const stats = scalarStats();
    const baseline: StatValues = { hp: 70 };
    const { values, applied } = fold(stats, baseline, []);
    expect(values).toEqual({ hp: 70 });
    expect(applied).toEqual([]);
  });

  it('never mutates the baseline (deep copy)', () => {
    const stats = affinityStats(true);
    const baseline: StatValues = { affinity: { 王大福: 50 } };
    fold(stats, baseline, [{ key: 'affinity', subkey: '王大福', delta: 20 }]);
    expect(baseline).toEqual({ affinity: { 王大福: 50 } });
  });

  it('clamps step-wise without remembering overflow', () => {
    const stats = scalarStats();
    const baseline: StatValues = { hp: 90 };
    // +30 would reach 120 but clamps to 100; -10 must drop from 100 to 90,
    // not from a remembered 120 to 110.
    const { values, applied } = fold(stats, baseline, [
      { key: 'hp', delta: 30 },
      { key: 'hp', delta: -10 },
    ]);
    expect(applied[0].after).toBe(100);
    expect(values['hp']).toBe(90);
  });

  it('clamps a scalar at the lower bound mid-sequence', () => {
    const stats = scalarStats();
    const { values } = fold(stats, { hp: 20 }, [
      { key: 'hp', delta: -50 },
      { key: 'hp', delta: 10 },
    ]);
    expect(values['hp']).toBe(10);
  });

  it('drops an unknown stat with a warning', () => {
    const stats = scalarStats();
    const { values, applied } = fold(stats, { hp: 100 }, [{ key: 'mana', delta: -5 }]);
    expect(values).toEqual({ hp: 100 });
    expect(applied[0].dropped).toBe(true);
    expect(applied[0].warning).toContain('Unknown stat');
  });

  it('accumulates an existing map subkey and clamps', () => {
    const stats = affinityStats(false);
    const { values } = fold(stats, { affinity: { 王大福: 90 } }, [
      { key: 'affinity', subkey: '王大福', delta: 30 },
    ]);
    expect((values['affinity'] as Record<string, number>)['王大福']).toBe(100);
  });

  it('drops an unauthorized new subkey and leaves values unchanged', () => {
    const stats = affinityStats(false);
    const baseline: StatValues = { affinity: { 王大福: 50 } };
    const { values, applied } = fold(stats, baseline, [
      { key: 'affinity', subkey: '王如花', value: 40 },
    ]);
    expect(values).toEqual({ affinity: { 王大福: 50 } });
    expect(applied[0].dropped).toBe(true);
    expect(applied[0].warning).toContain('not allowed');
  });

  it('drops an unauthorized new subkey without materializing an empty map', () => {
    const stats = affinityStats(false);
    const { values, applied } = fold(stats, {}, [
      { key: 'affinity', subkey: '王如花', value: 40 },
    ]);
    expect(values).toEqual({});
    expect(applied[0].dropped).toBe(true);
  });

  it('creates an authorized new subkey from an absolute value (clamped)', () => {
    const stats = affinityStats(true);
    const { values, applied } = fold(stats, { affinity: { 王大福: 50 } }, [
      { key: 'affinity', subkey: '王如花', value: 130 },
    ]);
    expect((values['affinity'] as Record<string, number>)['王如花']).toBe(100);
    expect(applied[0].dropped).toBeUndefined();
  });

  it('ignores an absolute value on an existing scalar and warns', () => {
    const stats = scalarStats();
    const { values, applied } = fold(stats, { hp: 80 }, [{ key: 'hp', value: 50 }]);
    expect(values['hp']).toBe(80);
    expect(applied[0].dropped).toBe(true);
    expect(applied[0].warning).toContain('protect accumulation');
  });

  it('ignores an absolute value on an existing subkey and warns', () => {
    const stats = affinityStats(true);
    const { values, applied } = fold(stats, { affinity: { 王大福: 50 } }, [
      { key: 'affinity', subkey: '王大福', value: 10 },
    ]);
    expect((values['affinity'] as Record<string, number>)['王大福']).toBe(50);
    expect(applied[0].dropped).toBe(true);
    expect(applied[0].warning).toContain('protect accumulation');
  });

  it('tolerates a delta on a not-yet-existing authorized subkey as its initial value', () => {
    const stats = affinityStats(true);
    const { values, applied } = fold(stats, { affinity: { 王大福: 50 } }, [
      { key: 'affinity', subkey: '王如花', delta: 30 },
    ]);
    expect((values['affinity'] as Record<string, number>)['王如花']).toBe(30);
    expect(applied[0].dropped).toBeUndefined();
    expect(applied[0].warning).toContain('initial value');
  });

  it('drops a subkey change targeting a scalar stat', () => {
    const stats = scalarStats();
    const { values, applied } = fold(stats, { hp: 100 }, [
      { key: 'hp', subkey: 'x', delta: 5 },
    ]);
    expect(values['hp']).toBe(100);
    expect(applied[0].dropped).toBe(true);
  });

  it('drops a subkey-less change on a map stat without clobbering the map', () => {
    const stats = affinityStats(true);
    const baseline: StatValues = { affinity: { 王大福: 50 } };
    const { values, applied } = fold(stats, baseline, [{ key: 'affinity', delta: 5 }]);
    expect(values).toEqual({ affinity: { 王大福: 50 } });
    expect(applied[0].dropped).toBe(true);
    expect(applied[0].warning).toContain('needs a subkey');
  });

  it('records before/after/reason in the audit trail', () => {
    const stats = scalarStats();
    const { applied } = fold(stats, { hp: 100 }, [
      { key: 'hp', delta: -20, reason: '受傷' },
    ]);
    expect(applied[0]).toMatchObject({ key: 'hp', before: 100, after: 80, reason: '受傷' });
  });
});

describe('computeCurrent', () => {
  it('flattens chronological delta lists in order and folds', () => {
    const stats = scalarStats();
    const baseline: StatValues = { hp: 100 };
    const deltaLists: StatChange[][] = [
      [{ key: 'hp', delta: -30 }],
      [{ key: 'hp', delta: -10 }, { key: 'hp', delta: 5 }],
    ];
    expect(computeCurrent(stats, baseline, deltaLists)).toEqual({ hp: 65 });
  });

  it('returns the baseline when no delta lists are given', () => {
    const stats = scalarStats();
    expect(computeCurrent(stats, { hp: 42 }, [])).toEqual({ hp: 42 });
  });
});

describe('evaluateEvents', () => {
  const hpStats: ParsedStats = {
    stats: { hp: { type: 'scalar', min: 0, max: 100, value: 100 } },
    rules: '',
    events: [],
  };

  it('fires a level event whenever the condition is true', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'level', trigger: '程楊宗倒下' },
    ];
    const out = evaluateEvents(hpStats, { hp: 0 }, { hp: 0 }, events);
    expect(out).toEqual(['程楊宗倒下']);
  });

  it('does not fire a level event when the condition is false', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'level', trigger: '程楊宗倒下' },
    ];
    expect(evaluateEvents(hpStats, { hp: 50 }, { hp: 50 }, events)).toEqual([]);
  });

  it('fires an edge event only on a false->true crossing', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'edge', trigger: '程楊宗倒下' },
    ];
    expect(evaluateEvents(hpStats, { hp: 10 }, { hp: 0 }, events)).toEqual(['程楊宗倒下']);
  });

  it('does not re-fire an edge event when the condition stays true', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'edge', trigger: '程楊宗倒下' },
    ];
    expect(evaluateEvents(hpStats, { hp: 0 }, { hp: 0 }, events)).toEqual([]);
  });

  it('re-fires an edge event after leaving and re-entering the range', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'edge', trigger: '程楊宗倒下' },
    ];
    // 0 -> 50 (leave) does not fire; 50 -> 0 (re-enter) fires again.
    expect(evaluateEvents(hpStats, { hp: 0 }, { hp: 50 }, events)).toEqual([]);
    expect(evaluateEvents(hpStats, { hp: 50 }, { hp: 0 }, events)).toEqual(['程楊宗倒下']);
  });

  it('treats first-turn prev as baseline for edge events', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'edge', trigger: '程楊宗倒下' },
    ];
    // baseline hp 100 (false) -> curr 0 (true) => fires on the first turn.
    expect(evaluateEvents(hpStats, { hp: 100 }, { hp: 0 }, events)).toEqual(['程楊宗倒下']);
  });

  it('fires multiple events in the same turn in event order', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 50', type: 'level', trigger: 'low' },
      { condition: 'hp.value <= 0', type: 'edge', trigger: 'down' },
    ];
    expect(evaluateEvents(hpStats, { hp: 60 }, { hp: 0 }, events)).toEqual(['low', 'down']);
  });

  it('evaluates a cross-stat condition over named params', () => {
    const stats: ParsedStats = {
      stats: {
        hp: { type: 'scalar', min: 0, max: 100, value: 100 },
        affinity: { type: 'map', min: 0, max: 100, value: {}, allow_new_item: true },
      },
      rules: '',
      events: [],
    };
    const events: StatEvent[] = [
      {
        condition: 'hp.value < 30 && affinity.value["王如花"] < 50',
        type: 'level',
        trigger: '危機',
      },
    ];
    const prev: StatValues = { hp: 100, affinity: { 王如花: 40 } };
    const curr: StatValues = { hp: 20, affinity: { 王如花: 40 } };
    expect(evaluateEvents(stats, prev, curr, events)).toEqual(['危機']);
  });

  it('exposes min/max on the named param', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value >= hp.max', type: 'level', trigger: 'full' },
    ];
    expect(evaluateEvents(hpStats, { hp: 100 }, { hp: 100 }, events)).toEqual(['full']);
  });

  it('compiles each condition once and reuses the cache', () => {
    const cache = new Map();
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'level', trigger: 'a' },
    ];
    evaluateEvents(hpStats, { hp: 0 }, { hp: 0 }, events, cache);
    const compiled = cache.get('hp|hp.value <= 0');
    evaluateEvents(hpStats, { hp: 0 }, { hp: 0 }, events, cache);
    expect(cache.size).toBe(1);
    expect(cache.get('hp|hp.value <= 0')).toBe(compiled);
  });

  it('does not reuse a cached fn across stat schemas with a different param order', () => {
    const cache = new Map();
    const condition = 'hp.value <= 0';
    const events: StatEvent[] = [{ condition, type: 'level', trigger: 'down' }];
    // Schema A params [mp, hp]; schema B params [hp, mp] — same condition string.
    const schemaA: ParsedStats = {
      stats: {
        mp: { type: 'scalar', min: 0, max: 100, value: 100 },
        hp: { type: 'scalar', min: 0, max: 100, value: 100 },
      },
      rules: '',
      events: [],
    };
    const schemaB: ParsedStats = {
      stats: {
        hp: { type: 'scalar', min: 0, max: 100, value: 100 },
        mp: { type: 'scalar', min: 0, max: 100, value: 100 },
      },
      rules: '',
      events: [],
    };
    evaluateEvents(schemaA, { mp: 50, hp: 50 }, { mp: 50, hp: 50 }, events, cache);
    // Under the old bug schemaB would reuse schemaA's fn and read hp from mp's slot.
    expect(evaluateEvents(schemaB, { hp: 0, mp: 50 }, { hp: 0, mp: 50 }, events, cache)).toEqual([
      'down',
    ]);
    expect(cache.size).toBe(2);
  });

  it('does not let a condition mutating a map subkey corrupt the ledger values', () => {
    const stats: ParsedStats = {
      stats: {
        affinity: { type: 'map', min: 0, max: 100, value: {}, allow_new_item: true },
      },
      rules: '',
      events: [],
    };
    // A malicious/buggy condition writes into the map it's handed; the ledger must
    // see a clone, so its own `values` stay intact.
    const events: StatEvent[] = [
      { condition: '(affinity.value["王大福"] = 999) > 0', type: 'level', trigger: 'x' },
    ];
    const prev: StatValues = { affinity: { 王大福: 50 } };
    const curr: StatValues = { affinity: { 王大福: 50 } };
    evaluateEvents(stats, prev, curr, events);
    expect(prev).toEqual({ affinity: { 王大福: 50 } });
    expect(curr).toEqual({ affinity: { 王大福: 50 } });
  });

  it('treats an uncompilable condition as not-triggered and warns', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <<< 0', type: 'level', trigger: 'boom' },
    ];
    const warnings: string[] = [];
    const out = evaluateEvents(hpStats, { hp: 50 }, { hp: 50 }, events, new Map(), warnings);
    expect(out).toEqual([]);
    expect(warnings[0]).toContain('failed to compile');
  });

  it('treats a throwing condition as not-triggered and warns', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value.nope.crash()', type: 'level', trigger: 'boom' },
    ];
    const warnings: string[] = [];
    const out = evaluateEvents(hpStats, { hp: 50 }, { hp: 50 }, events, new Map(), warnings);
    expect(out).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not execute injected code when a stat key bypasses key validation', () => {
    // A ParsedStats crafted directly (not via parseStats, which rejects this key)
    // smuggles a malicious param name into compileCondition's `new Function`. The
    // defense-in-depth guard must compile it to a non-triggering fn, never run it.
    const pwnKey = Symbol.for('stat-pwn');
    const sink = globalThis as unknown as Record<symbol, unknown>;
    delete sink[pwnKey];
    const malicious = 'hp),{}; (globalThis[Symbol.for("stat-pwn")]=1);//';
    const stats: ParsedStats = {
      stats: { [malicious]: { type: 'scalar', min: 0, max: 100, value: 0 } },
      rules: '',
      events: [],
    };
    const events: StatEvent[] = [{ condition: 'true', type: 'level', trigger: 'boom' }];
    const warnings: string[] = [];
    const out = evaluateEvents(
      stats,
      { [malicious]: 0 },
      { [malicious]: 0 },
      events,
      new Map(),
      warnings,
    );
    expect(out).toEqual([]);
    expect(sink[pwnKey]).toBeUndefined();
    expect(warnings.some((w) => w.includes('invalid stat param name'))).toBe(true);
  });

  it('console.warns a throwing condition when no warnings array is supplied', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value.nope.crash()', type: 'level', trigger: 'boom' },
    ];
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const out = evaluateEvents(hpStats, { hp: 50 }, { hp: 50 }, events);
      expect(out).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain('[StatLedger]');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('StatLedgerService', () => {
  it('delegates to the pure functions', () => {
    const service = new StatLedgerService();
    const stats = scalarStats();
    expect(service.clamp(150, 0, 100)).toBe(100);
    expect(service.fold(stats, { hp: 100 }, [{ key: 'hp', delta: -10 }]).values['hp']).toBe(90);
    expect(service.computeCurrent(stats, { hp: 100 }, [[{ key: 'hp', delta: -5 }]])).toEqual({
      hp: 95,
    });
  });

  it('caches compiled conditions across evaluateEvents calls', () => {
    const service = new StatLedgerService();
    const stats = scalarStats();
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'level', trigger: 'x' },
    ];
    expect(service.evaluateEvents(stats, { hp: 0 }, { hp: 0 }, events)).toEqual(['x']);
    expect(service.evaluateEvents(stats, { hp: 0 }, { hp: 0 }, events)).toEqual(['x']);
  });
});
