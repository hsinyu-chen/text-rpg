import { describe, expect, it } from 'vitest';
import { AppliedDelta } from '../../models/stats.types';
import { buildStatChips, StatChipOptions } from './stats-chip.util';

const OPTS: StatChipOptions = {
  eventTooltip: 'event!',
  droppedPrefix: 'Ignored: ',
  colorFor: key => (key === 'hp' ? '#ff0000' : undefined),
};

function delta(partial: Partial<AppliedDelta>): AppliedDelta {
  return { key: 'hp', before: 0, after: 0, ...partial };
}

describe('buildStatChips', () => {
  it('returns [] for a turn that changed nothing', () => {
    expect(buildStatChips([], [], OPTS)).toEqual([]);
  });

  it('labels a gain with +delta, gain kind, and the declared colour', () => {
    const [chip] = buildStatChips([delta({ key: 'hp', before: 10, after: 13, reason: 'rest' })], [], OPTS);
    expect(chip).toMatchObject({ label: 'hp +3', kind: 'gain', tooltip: 'rest', color: '#ff0000' });
  });

  it('labels a loss with -delta and no colour when the stat declares none', () => {
    const [chip] = buildStatChips([delta({ key: 'mp', before: 5, after: 2 })], [], OPTS);
    expect(chip).toMatchObject({ label: 'mp -3', kind: 'loss' });
    expect(chip.color).toBeUndefined();
  });

  it('marks a no-net change neutral', () => {
    const [chip] = buildStatChips([delta({ key: 'hp', before: 7, after: 7 })], [], OPTS);
    expect(chip).toMatchObject({ label: 'hp 0', kind: 'neutral' });
  });

  it('targets a map subkey as key.subkey', () => {
    const [chip] = buildStatChips([delta({ key: 'inv', subkey: 'potion', before: 0, after: 2 })], [], OPTS);
    expect(chip.label).toBe('inv.potion +2');
  });

  it('targets a bound change as key.field', () => {
    const [chip] = buildStatChips([delta({ key: 'hp', field: 'max', before: 100, after: 120 })], [], OPTS);
    expect(chip).toMatchObject({ label: 'hp.max +20', kind: 'gain', color: '#ff0000' });
  });

  it('renders a dropped change with the requested delta and the prefixed warning', () => {
    const [chip] = buildStatChips(
      [delta({ key: 'gold', dropped: true, delta: -5, warning: 'no funds' })],
      [],
      OPTS
    );
    expect(chip).toMatchObject({ label: 'gold -5', kind: 'dropped', tooltip: 'Ignored: no funds' });
  });

  it('renders a dropped absolute-set with =value and falls back to reason when no warning', () => {
    const [chip] = buildStatChips(
      [delta({ key: 'gold', dropped: true, value: 100, reason: 'locked' })],
      [],
      OPTS
    );
    expect(chip).toMatchObject({ label: 'gold =100', tooltip: 'Ignored: locked' });
  });

  it('renders a bare dropped change (no delta/value) as just the target', () => {
    const [chip] = buildStatChips([delta({ key: 'gold', dropped: true })], [], OPTS);
    expect(chip.label).toBe('gold');
  });

  it('appends triggered events as event chips after the changes', () => {
    const chips = buildStatChips([delta({ key: 'hp', before: 0, after: 1 })], ['Level Up'], OPTS);
    expect(chips.map(c => c.kind)).toEqual(['gain', 'event']);
    expect(chips[1]).toMatchObject({ label: 'Level Up', kind: 'event', tooltip: 'event!' });
    expect(chips[1].color).toBeUndefined();
  });
});
