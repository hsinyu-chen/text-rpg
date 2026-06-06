import { describe, expect, it } from 'vitest';
import { isValidStatKey, parseStats } from './stats-yaml.util';

describe('parseStats', () => {
  it('parses a full stats document', () => {
    const { parsed, warnings } = parseStats(`
stats:
  hp:
    type: scalar
    min: 0
    max: 100
    value: 80
    desc: 生命值
  affinity:
    type: map
    min: 0
    max: 100
    allow_new_item: true
    new_item_rule: 出現新角色時建立
    value:
      王大福: 50
rules: 受傷扣 hp，相處加好感
events:
  - condition: hp.value <= 0
    type: edge
    trigger: 程楊宗倒下
`);
    expect(warnings).toEqual([]);
    expect(parsed.stats['hp']).toEqual({
      type: 'scalar',
      min: 0,
      max: 100,
      value: 80,
      desc: '生命值',
      allow_new_item: false,
    });
    expect(parsed.stats['affinity']).toMatchObject({
      type: 'map',
      allow_new_item: true,
      new_item_rule: '出現新角色時建立',
      value: { 王大福: 50 },
    });
    expect(parsed.rules).toBe('受傷扣 hp，相處加好感');
    expect(parsed.events).toEqual([
      { condition: 'hp.value <= 0', type: 'edge', trigger: '程楊宗倒下' },
    ]);
  });

  it('returns lenient defaults for an empty document', () => {
    expect(parseStats('').parsed).toEqual({ stats: {}, rules: '', events: [] });
  });

  it('returns lenient defaults when top-level sections are missing', () => {
    const { parsed } = parseStats('rules: just rules');
    expect(parsed.stats).toEqual({});
    expect(parsed.rules).toBe('just rules');
    expect(parsed.events).toEqual([]);
  });

  it('infers scalar type from a numeric value when type is absent', () => {
    const { parsed } = parseStats(`
stats:
  gold:
    value: 100
`);
    expect(parsed.stats['gold'].type).toBe('scalar');
    expect(parsed.stats['gold'].value).toBe(100);
  });

  it('infers map type from an object value when type is absent', () => {
    const { parsed } = parseStats(`
stats:
  affinity:
    value:
      王如花: 30
`);
    expect(parsed.stats['affinity'].type).toBe('map');
    expect(parsed.stats['affinity'].value).toEqual({ 王如花: 30 });
  });

  it('defaults allow_new_item to false', () => {
    const { parsed } = parseStats(`
stats:
  affinity:
    type: map
    value: {}
`);
    expect(parsed.stats['affinity'].allow_new_item).toBe(false);
  });

  it('drops a stat with an invalid (spaced) key and warns', () => {
    const { parsed, warnings } = parseStats(`
stats:
  "bad key":
    value: 1
  hp:
    value: 10
`);
    expect(parsed.stats['bad key']).toBeUndefined();
    expect(parsed.stats['hp']).toBeDefined();
    expect(warnings.some((w) => w.includes('bad key'))).toBe(true);
  });

  it('drops a stat with a symbol key and warns', () => {
    const { parsed, warnings } = parseStats(`
stats:
  "hp-current":
    value: 1
`);
    expect(parsed.stats['hp-current']).toBeUndefined();
    expect(warnings.length).toBe(1);
  });

  it('drops a stat with a leading-digit key and warns', () => {
    const { parsed, warnings } = parseStats(`
stats:
  "1hp":
    value: 1
`);
    expect(parsed.stats['1hp']).toBeUndefined();
    expect(warnings.length).toBe(1);
  });

  it('accepts a CJK stat key', () => {
    const { parsed, warnings } = parseStats(`
stats:
  生命:
    value: 50
`);
    expect(parsed.stats['生命']).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it('tolerates a non-object stat entry by dropping it with a warning', () => {
    const { parsed, warnings } = parseStats(`
stats:
  hp: 80
  mp:
    value: 10
`);
    expect(parsed.stats['hp']).toBeUndefined();
    expect(parsed.stats['mp']).toBeDefined();
    expect(warnings.some((w) => w.includes('hp'))).toBe(true);
  });

  it('tolerates events that are not a list', () => {
    const { parsed, warnings } = parseStats(`
events: not-a-list
`);
    expect(parsed.events).toEqual([]);
    expect(warnings.some((w) => w.includes('events'))).toBe(true);
  });

  it('drops malformed events but keeps valid ones', () => {
    const { parsed, warnings } = parseStats(`
events:
  - condition: hp.value <= 0
    trigger: 程楊宗倒下
  - condition: hp.value <= 0
  - not-a-mapping
`);
    expect(parsed.events).toEqual([
      { condition: 'hp.value <= 0', type: 'level', trigger: '程楊宗倒下' },
    ]);
    expect(warnings.length).toBe(2);
  });

  it('defaults event type to level when omitted', () => {
    const { parsed } = parseStats(`
events:
  - condition: hp.value <= 0
    trigger: x
`);
    expect(parsed.events[0].type).toBe('level');
  });

  it('tolerates a non-mapping stats section', () => {
    const { parsed, warnings } = parseStats('stats: oops');
    expect(parsed.stats).toEqual({});
    expect(warnings.some((w) => w.includes('stats'))).toBe(true);
  });

  it('ignores a non-mapping top-level document', () => {
    const { parsed } = parseStats('- a\n- b');
    expect(parsed).toEqual({ stats: {}, rules: '', events: [] });
  });

  it('coerces non-numeric subkeys out of a map value', () => {
    const { parsed } = parseStats(`
stats:
  affinity:
    type: map
    value:
      王大福: 50
      bad: hello
`);
    expect(parsed.stats['affinity'].value).toEqual({ 王大福: 50 });
  });

  it('does not throw on malformed-but-parseable content', () => {
    expect(() =>
      parseStats(`
stats: 123
events: 5
rules: 7
`),
    ).not.toThrow();
  });

  it('throws only on a genuine YAML syntax error', () => {
    expect(() => parseStats('key: [unclosed')).toThrow();
  });
});

describe('isValidStatKey', () => {
  it('accepts ASCII identifiers', () => {
    expect(isValidStatKey('hp')).toBe(true);
    expect(isValidStatKey('affinity_map')).toBe(true);
    expect(isValidStatKey('$x')).toBe(true);
  });

  it('accepts CJK identifiers', () => {
    expect(isValidStatKey('生命')).toBe(true);
    expect(isValidStatKey('好感度')).toBe(true);
  });

  it('rejects spaces, symbols, and leading digits', () => {
    expect(isValidStatKey('bad key')).toBe(false);
    expect(isValidStatKey('hp-current')).toBe(false);
    expect(isValidStatKey('1hp')).toBe(false);
    expect(isValidStatKey('')).toBe(false);
  });
});
