import { describe, expect, it, vi } from 'vitest';
import {
  ParsedStats,
  StatBounds,
  StatChange,
  StatEvent,
  StatState,
  StatValues,
} from '../../models/stats.types';
import {
  clamp,
  computeCurrent,
  evaluateEvents,
  fold,
  renderStatDefinitions,
  renderStatValues,
  renderStatValuesWithRange,
  StatLedgerService,
} from './stat-ledger.service';

/** Wrap bare values (and optional bounds) into a {@link StatState} for the prev/curr args. */
const st = (values: StatValues, bounds: StatBounds = {}): StatState => ({ values, bounds });

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

  it('treats an empty / whitespace subkey on a scalar as no subkey (applies it)', () => {
    const stats = scalarStats();
    const { values, applied } = fold(stats, { hp: 100 }, [
      { key: 'hp', subkey: '', delta: -5 },
      { key: 'hp', subkey: '   ', delta: -5 },
    ]);
    expect(values['hp']).toBe(90);
    expect(applied[0].dropped).toBeUndefined();
    expect(applied[0].subkey).toBeUndefined();
    expect(applied[1].dropped).toBeUndefined();
  });

  it('still drops an empty subkey on a map stat (a map needs a real subkey)', () => {
    const stats = affinityStats(true);
    const { applied } = fold(stats, { affinity: { 王大福: 50 } }, [
      { key: 'affinity', subkey: '', delta: 5 },
    ]);
    expect(applied[0].dropped).toBe(true);
    expect(applied[0].warning).toContain('needs a subkey');
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

describe('fold — dynamic bounds', () => {
  function openScalar(): ParsedStats {
    return { stats: { score: { type: 'scalar', value: 0 } }, rules: '', events: [] };
  }

  it('raising max opens headroom without changing the value', () => {
    const { values, bounds } = fold(scalarStats(), { hp: 100 }, [
      { key: 'hp', field: 'max', delta: 50 },
    ]);
    expect(values['hp']).toBe(100);
    expect(bounds['hp']).toEqual({ min: 0, max: 150 });
  });

  it('lets a value grow past the old max once the max is raised', () => {
    const { values } = fold(scalarStats(), { hp: 100 }, [
      { key: 'hp', field: 'max', delta: 50 },
      { key: 'hp', delta: 40 },
    ]);
    expect(values['hp']).toBe(140);
  });

  it('lowering max below the current value drags the value down (debuff cap)', () => {
    const { values, bounds } = fold(scalarStats(), { hp: 90 }, [
      { key: 'hp', field: 'max', delta: -30 },
    ]);
    expect(bounds['hp']).toEqual({ min: 0, max: 70 });
    expect(values['hp']).toBe(70);
  });

  it('raising min above the current value pulls the value up', () => {
    const { values, bounds } = fold(scalarStats(), { hp: 10 }, [
      { key: 'hp', field: 'min', delta: 20 },
    ]);
    expect(bounds['hp']).toEqual({ min: 20, max: 100 });
    expect(values['hp']).toBe(20);
  });

  it('sets a bound absolutely with value (and re-clamps the value)', () => {
    const { values, bounds } = fold(scalarStats(), { hp: 100 }, [
      { key: 'hp', field: 'max', value: 80 },
    ]);
    expect(bounds['hp']).toEqual({ min: 0, max: 80 });
    expect(values['hp']).toBe(80);
  });

  it('drops a delta on an open (unset) bound and materializes no override', () => {
    const { applied, bounds } = fold(openScalar(), { score: 5 }, [
      { key: 'score', field: 'max', delta: 10 },
    ]);
    expect(applied[0].dropped).toBe(true);
    expect(applied[0].warning).toContain('open');
    expect(bounds).toEqual({});
  });

  it('introduces a previously-open bound via an absolute value', () => {
    const { values, bounds } = fold(openScalar(), { score: 120 }, [
      { key: 'score', field: 'max', value: 100 },
    ]);
    expect(bounds['score']).toEqual({ max: 100 });
    expect(values['score']).toBe(100);
  });

  it('drops a bound change that would invert the range', () => {
    const { applied, bounds, values } = fold(scalarStats(), { hp: 50 }, [
      { key: 'hp', field: 'max', value: -10 },
    ]);
    expect(applied[0].dropped).toBe(true);
    expect(applied[0].warning).toContain('invert');
    expect(bounds).toEqual({});
    expect(values['hp']).toBe(50);
  });

  it('re-clamps every subkey when a map stat bound shrinks', () => {
    const { values, bounds } = fold(affinityStats(true), { affinity: { 王大福: 90, 李如玉: 60 } }, [
      { key: 'affinity', field: 'max', delta: -30 },
    ]);
    expect(bounds['affinity']).toEqual({ min: 0, max: 70 });
    expect(values['affinity']).toEqual({ 王大福: 70, 李如玉: 60 });
  });

  it('applies a bound change at stat level, ignoring any subkey', () => {
    const { bounds } = fold(affinityStats(true), { affinity: { 王大福: 50 } }, [
      { key: 'affinity', subkey: '王大福', field: 'max', delta: -40 },
    ]);
    expect(bounds['affinity']).toEqual({ min: 0, max: 60 });
  });

  it('seeds the live bounds from baselineBounds for an incremental fold', () => {
    const { values, bounds } = fold(
      scalarStats(),
      { hp: 120 },
      [{ key: 'hp', delta: 40 }],
      { hp: { min: 0, max: 150 } },
    );
    expect(values['hp']).toBe(150);
    expect(bounds['hp']).toEqual({ min: 0, max: 150 });
  });

  it('never mutates baselineBounds (deep copy)', () => {
    const baselineBounds: StatBounds = { hp: { min: 0, max: 150 } };
    fold(scalarStats(), { hp: 100 }, [{ key: 'hp', field: 'max', delta: 20 }], baselineBounds);
    expect(baselineBounds).toEqual({ hp: { min: 0, max: 150 } });
  });

  it('keeps the declared bound for a side a partial overlay leaves unset (value change)', () => {
    // Overlay carries only min; the declared max (100) must still clamp, not be
    // treated as open — boundsFor merges the overlay over the definition per side.
    const { values } = fold(scalarStats(), { hp: 90 }, [{ key: 'hp', delta: 50 }], {
      hp: { min: 0 },
    });
    expect(values['hp']).toBe(100);
  });

  it('re-clamps against the declared bound a partial overlay omits (bound change)', () => {
    // Partial baseline overlay: hp.min set, hp.max absent (declared 100). A bound
    // change re-clamps via ensureBounds — which must resolve max from the def, so
    // the pre-clamped 150 drops to 100 rather than staying open.
    const { values, bounds } = fold(
      scalarStats(),
      { hp: 150 },
      [{ key: 'hp', field: 'min', value: 0 }],
      { hp: { min: 0 } },
    );
    expect(values['hp']).toBe(100);
    expect(bounds['hp']).toEqual({ min: 0, max: 100 });
  });

  it('records the field and before/after bound in the audit trail', () => {
    const { applied } = fold(scalarStats(), { hp: 100 }, [
      { key: 'hp', field: 'max', delta: 50, reason: '升級' },
    ]);
    expect(applied[0]).toMatchObject({
      key: 'hp',
      field: 'max',
      before: 100,
      after: 150,
      delta: 50,
      reason: '升級',
    });
    // delta decided `next`, so the unused `value` is absent from the audit.
    expect(applied[0].value).toBeUndefined();
  });

  it('records only value (not the ignored delta) when both are given on a bound change', () => {
    const { applied, bounds } = fold(scalarStats(), { hp: 100 }, [
      { key: 'hp', field: 'max', value: 80, delta: 999 },
    ]);
    expect(bounds['hp']).toEqual({ min: 0, max: 80 });
    expect(applied[0]).toMatchObject({ key: 'hp', field: 'max', value: 80 });
    expect(applied[0].delta).toBeUndefined();
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
    expect(computeCurrent(stats, baseline, deltaLists)).toEqual({ values: { hp: 65 }, bounds: {} });
  });

  it('returns the baseline when no delta lists are given', () => {
    const stats = scalarStats();
    expect(computeCurrent(stats, { hp: 42 }, [])).toEqual({ values: { hp: 42 }, bounds: {} });
  });

  it('rolls bound changes across history into the live bounds', () => {
    const stats = scalarStats();
    const deltaLists: StatChange[][] = [
      [{ key: 'hp', field: 'max', delta: 50 }],
      [{ key: 'hp', delta: 40 }],
    ];
    // max 100 -> 150, then hp 100 + 40 clamps to 140 (the grown max, not 100).
    expect(computeCurrent(stats, { hp: 100 }, deltaLists)).toEqual({
      values: { hp: 140 },
      bounds: { hp: { min: 0, max: 150 } },
    });
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
    const out = evaluateEvents(hpStats, st({ hp: 0 }), st({ hp: 0 }), events);
    expect(out).toEqual(['程楊宗倒下']);
  });

  it('does not fire a level event when the condition is false', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'level', trigger: '程楊宗倒下' },
    ];
    expect(evaluateEvents(hpStats, st({ hp: 50 }), st({ hp: 50 }), events)).toEqual([]);
  });

  it('fires an edge event only on a false->true crossing', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'edge', trigger: '程楊宗倒下' },
    ];
    expect(evaluateEvents(hpStats, st({ hp: 10 }), st({ hp: 0 }), events)).toEqual(['程楊宗倒下']);
  });

  it('does not re-fire an edge event when the condition stays true', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'edge', trigger: '程楊宗倒下' },
    ];
    expect(evaluateEvents(hpStats, st({ hp: 0 }), st({ hp: 0 }), events)).toEqual([]);
  });

  it('re-fires an edge event after leaving and re-entering the range', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'edge', trigger: '程楊宗倒下' },
    ];
    // 0 -> 50 (leave) does not fire; 50 -> 0 (re-enter) fires again.
    expect(evaluateEvents(hpStats, st({ hp: 0 }), st({ hp: 50 }), events)).toEqual([]);
    expect(evaluateEvents(hpStats, st({ hp: 50 }), st({ hp: 0 }), events)).toEqual(['程楊宗倒下']);
  });

  it('treats first-turn prev as baseline for edge events', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'edge', trigger: '程楊宗倒下' },
    ];
    // baseline hp 100 (false) -> curr 0 (true) => fires on the first turn.
    expect(evaluateEvents(hpStats, st({ hp: 100 }), st({ hp: 0 }), events)).toEqual(['程楊宗倒下']);
  });

  it('fires multiple events in the same turn in event order', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <= 50', type: 'level', trigger: 'low' },
      { condition: 'hp.value <= 0', type: 'edge', trigger: 'down' },
    ];
    expect(evaluateEvents(hpStats, st({ hp: 60 }), st({ hp: 0 }), events)).toEqual(['low', 'down']);
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
    expect(evaluateEvents(stats, st(prev), st(curr), events)).toEqual(['危機']);
  });

  it('exposes min/max on the named param', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value >= hp.max', type: 'level', trigger: 'full' },
    ];
    expect(evaluateEvents(hpStats, st({ hp: 100 }), st({ hp: 100 }), events)).toEqual(['full']);
  });

  it('reads the LIVE (overridden) max in a condition, not the declared one', () => {
    // Declared max is 100, but the live bounds raised it to 150. `hp.value >= hp.max`
    // at value 120 must be false (120 < 150); a static def.max=100 would wrongly fire.
    const events: StatEvent[] = [
      { condition: 'hp.value >= hp.max', type: 'level', trigger: 'full' },
    ];
    const grown = st({ hp: 120 }, { hp: { min: 0, max: 150 } });
    expect(evaluateEvents(hpStats, grown, grown, events)).toEqual([]);
    const atGrownMax = st({ hp: 150 }, { hp: { min: 0, max: 150 } });
    expect(evaluateEvents(hpStats, atGrownMax, atGrownMax, events)).toEqual(['full']);
  });

  it('fires an edge event when only the live max moved between prev and curr', () => {
    // value stays 100; prev max 100 (100>=100 true), curr max 150 (100>=150 false).
    // A "dropped below full" edge therefore crosses true->false (no fire), while the
    // inverse condition crosses false->true.
    const events: StatEvent[] = [
      { condition: 'hp.value < hp.max', type: 'edge', trigger: 'no_longer_full' },
    ];
    const prev = st({ hp: 100 }, { hp: { min: 0, max: 100 } });
    const curr = st({ hp: 100 }, { hp: { min: 0, max: 150 } });
    expect(evaluateEvents(hpStats, prev, curr, events)).toEqual(['no_longer_full']);
  });

  it('compiles each condition once and reuses the cache', () => {
    const cache = new Map();
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'level', trigger: 'a' },
    ];
    evaluateEvents(hpStats, st({ hp: 0 }), st({ hp: 0 }), events, cache);
    const compiled = cache.get('hp|hp.value <= 0');
    evaluateEvents(hpStats, st({ hp: 0 }), st({ hp: 0 }), events, cache);
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
    evaluateEvents(schemaA, st({ mp: 50, hp: 50 }), st({ mp: 50, hp: 50 }), events, cache);
    // Under the old bug schemaB would reuse schemaA's fn and read hp from mp's slot.
    expect(
      evaluateEvents(schemaB, st({ hp: 0, mp: 50 }), st({ hp: 0, mp: 50 }), events, cache),
    ).toEqual(['down']);
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
    evaluateEvents(stats, st(prev), st(curr), events);
    expect(prev).toEqual({ affinity: { 王大福: 50 } });
    expect(curr).toEqual({ affinity: { 王大福: 50 } });
  });

  it('treats an uncompilable condition as not-triggered and warns', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value <<< 0', type: 'level', trigger: 'boom' },
    ];
    const warnings: string[] = [];
    const out = evaluateEvents(hpStats, st({ hp: 50 }), st({ hp: 50 }), events, new Map(), warnings);
    expect(out).toEqual([]);
    expect(warnings[0]).toContain('failed to compile');
  });

  it('treats a throwing condition as not-triggered and warns', () => {
    const events: StatEvent[] = [
      { condition: 'hp.value.nope.crash()', type: 'level', trigger: 'boom' },
    ];
    const warnings: string[] = [];
    const out = evaluateEvents(hpStats, st({ hp: 50 }), st({ hp: 50 }), events, new Map(), warnings);
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
      st({ [malicious]: 0 }),
      st({ [malicious]: 0 }),
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
      const out = evaluateEvents(hpStats, st({ hp: 50 }), st({ hp: 50 }), events);
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
      values: { hp: 95 },
      bounds: {},
    });
  });

  it('caches compiled conditions across evaluateEvents calls', () => {
    const service = new StatLedgerService();
    const stats = scalarStats();
    const events: StatEvent[] = [
      { condition: 'hp.value <= 0', type: 'level', trigger: 'x' },
    ];
    expect(service.evaluateEvents(stats, st({ hp: 0 }), st({ hp: 0 }), events)).toEqual(['x']);
    expect(service.evaluateEvents(stats, st({ hp: 0 }), st({ hp: 0 }), events)).toEqual(['x']);
  });

  it('renderStatValues delegates to the pure function', () => {
    const service = new StatLedgerService();
    expect(service.renderStatValues(scalarStats(), { hp: 42 })).toBe('hp: 42');
  });

  it('renderStatValuesWithRange delegates to the pure function', () => {
    const service = new StatLedgerService();
    expect(service.renderStatValuesWithRange(scalarStats(), { hp: 42 })).toBe('hp: 42 (0–100)');
  });

  it('renderStatDefinitions delegates to the pure function', () => {
    const service = new StatLedgerService();
    expect(service.renderStatDefinitions(scalarStats())).toBe('hp (scalar, 0–100)');
  });
});

describe('renderStatValues', () => {
  it('renders a scalar as `key: n`', () => {
    expect(renderStatValues(scalarStats(), { hp: 73 })).toBe('hp: 73');
  });

  it('renders a map as `key: { sub: n, ... }`', () => {
    const out = renderStatValues(affinityStats(true), { affinity: { 王大福: 60, 李如玉: 30 } });
    expect(out).toBe('affinity: { 王大福: 60, 李如玉: 30 }');
  });

  it('renders an empty map as `key: {}`', () => {
    expect(renderStatValues(affinityStats(true), { affinity: {} })).toBe('affinity: {  }');
  });

  it('falls back to the declared shape (0 / empty map) for a stat missing from values', () => {
    const stats: ParsedStats = {
      stats: {
        hp: { type: 'scalar', value: 100 },
        affinity: { type: 'map', value: {} },
      },
      rules: '',
      events: [],
    };
    expect(renderStatValues(stats, {})).toBe('hp: 0\naffinity: {  }');
  });

  it('returns empty string when no stats are declared', () => {
    expect(renderStatValues({ stats: {}, rules: '', events: [] }, {})).toBe('');
  });
});

describe('renderStatValuesWithRange', () => {
  it('renders a scalar with its declared bounds', () => {
    expect(renderStatValuesWithRange(scalarStats(), { hp: 95 })).toBe('hp: 95 (0–100)');
  });

  it('omits the range for a scalar with no bounds', () => {
    const stats: ParsedStats = { stats: { gold: { type: 'scalar', value: 0 } }, rules: '', events: [] };
    expect(renderStatValuesWithRange(stats, { gold: 320 })).toBe('gold: 320');
  });

  it('renders a map stat with bounds', () => {
    const out = renderStatValuesWithRange(affinityStats(true), { affinity: { 王大福: 60 } });
    expect(out).toBe('affinity: { 王大福: 60 } (0–100)');
  });

  it('renders an empty map with its bounds, value byte-identical to renderStatValues', () => {
    const stats = affinityStats(true);
    expect(renderStatValuesWithRange(stats, { affinity: {} })).toBe('affinity: {  } (0–100)');
    // Value text must match renderStatValues exactly.
    expect(renderStatValues(stats, { affinity: {} })).toBe('affinity: {  }');
  });

  it('uses LIVE bounds when they differ from the declared bounds', () => {
    // Declared 0–100; a field:"max" change dropped the live max to 50.
    const liveBounds = { hp: { min: 0, max: 50 } };
    expect(renderStatValuesWithRange(scalarStats(), { hp: 50 }, liveBounds)).toBe('hp: 50 (0–50)');
  });

  it('returns empty string when no stats are declared', () => {
    expect(renderStatValuesWithRange({ stats: {}, rules: '', events: [] }, {})).toBe('');
  });
});

describe('renderStatDefinitions', () => {
  it('renders a scalar with both bounds and a desc', () => {
    const stats: ParsedStats = {
      stats: { hp: { type: 'scalar', min: 0, max: 100, value: 100, desc: '生命值' } },
      rules: '',
      events: [],
    };
    expect(renderStatDefinitions(stats)).toBe('hp — 生命值 (scalar, 0–100)');
  });

  it('marks a map that allows new items', () => {
    const stats: ParsedStats = {
      stats: {
        affinity: {
          type: 'map',
          min: 0,
          max: 100,
          value: { 王大福: 50 },
          allow_new_item: true,
          desc: 'NPC affinity',
        },
      },
      rules: '',
      events: [],
    };
    expect(renderStatDefinitions(stats)).toBe('affinity — NPC affinity (map, 0–100, new items allowed)');
  });

  it('omits the range when neither min nor max is set, and renders one-sided bounds', () => {
    const stats: ParsedStats = {
      stats: {
        score: { type: 'scalar', value: 0, desc: 'running score' },
        gold: { type: 'scalar', min: 0, value: 10 },
        fatigue: { type: 'scalar', max: 100, value: 0 },
      },
      rules: '',
      events: [],
    };
    expect(renderStatDefinitions(stats)).toBe(
      'score — running score (scalar)\ngold (scalar, ≥0)\nfatigue (scalar, ≤100)',
    );
  });

  it('omits the desc segment when a stat has no desc', () => {
    expect(renderStatDefinitions(scalarStats())).toBe('hp (scalar, 0–100)');
  });

  it('preserves declaration order', () => {
    const stats: ParsedStats = {
      stats: {
        b: { type: 'scalar', value: 0, desc: 'second key declared first slot' },
        a: { type: 'scalar', value: 0 },
      },
      rules: '',
      events: [],
    };
    expect(renderStatDefinitions(stats)).toBe('b — second key declared first slot (scalar)\na (scalar)');
  });

  it('reflects the live bounds overlay in the range', () => {
    const stats: ParsedStats = {
      stats: { hp: { type: 'scalar', min: 0, max: 100, value: 100, desc: '生命值' } },
      rules: '',
      events: [],
    };
    expect(renderStatDefinitions(stats, { hp: { min: 0, max: 150 } })).toBe(
      'hp — 生命值 (scalar, 0–150)',
    );
  });

  it('returns empty string when no stats are declared', () => {
    expect(renderStatDefinitions({ stats: {}, rules: '', events: [] })).toBe('');
  });
});
