import { describe, expect, it, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { StatsViewService } from './stats-view.service';
import { GameStateService } from '../game-state.service';
import { LOCALES } from '../../constants/locales';
import { ChatMessage } from '../../models/types';

const STATS_FILE = Object.values(LOCALES)[0].optionalFilenames.STATS_YAML;

const LEDGER_YAML = [
  'stats:',
  '  hp:',
  '    value: 100',
  '    min: 0',
  '    max: 100',
  'events:',
  '  - condition: "hp.value <= 0"',
  '    type: level',
  '    trigger: down',
].join('\n');

describe('StatsViewService.appliedForMessage', () => {
  const messages = signal<ChatMessage[]>([]);
  const loadedFiles = signal<Map<string, string>>(new Map());
  let service: StatsViewService;

  beforeEach(() => {
    messages.set([]);
    loadedFiles.set(new Map());
    TestBed.configureTestingModule({
      providers: [
        StatsViewService,
        { provide: GameStateService, useValue: { messages, loadedFiles } },
      ],
    });
    service = TestBed.inject(StatsViewService);
  });

  function withLedger(): void {
    loadedFiles.set(new Map([[STATS_FILE, LEDGER_YAML]]));
  }

  it('returns null when no Book opted into the stats system', () => {
    messages.set([{ id: 'm1', role: 'model', content: 's', stat_delta: [{ key: 'hp', delta: -10 }] }]);
    expect(service.appliedForMessage('m1')).toBeNull();
  });

  it('returns the applied audit for a model message with stat_delta', () => {
    withLedger();
    messages.set([
      { id: 'u1', role: 'user', content: 'x' },
      { id: 'm1', role: 'model', content: 's', stat_delta: [{ key: 'hp', delta: -10, reason: '中箭' }] },
    ]);
    const view = service.appliedForMessage('m1');
    expect(view?.applied).toEqual([
      { key: 'hp', before: 100, after: 90, delta: -10, reason: '中箭' },
    ]);
    expect(view?.triggered).toEqual([]);
  });

  it('folds the active history before the message off the current ledger', () => {
    withLedger();
    messages.set([
      { id: 'm0', role: 'model', content: 's', stat_delta: [{ key: 'hp', delta: -30 }] },
      { id: 'm1', role: 'model', content: 's', stat_delta: [{ key: 'hp', delta: -10 }] },
    ]);
    const view = service.appliedForMessage('m1');
    // prev folds m0 (-30) onto 100 = 70; this turn -10 => 60.
    expect(view?.applied[0]).toMatchObject({ before: 70, after: 60 });
  });

  it('reflects clamping in the applied audit (effective, not requested)', () => {
    withLedger();
    messages.set([
      { id: 'm1', role: 'model', content: 's', stat_delta: [{ key: 'hp', delta: -150 }] },
    ]);
    const view = service.appliedForMessage('m1');
    // -150 clamps at min 0; after-before is the effective -100, not -150.
    expect(view?.applied[0]).toMatchObject({ before: 100, after: 0, delta: -150 });
  });

  it('surfaces triggered events across the pre/post pair', () => {
    withLedger();
    messages.set([
      { id: 'm1', role: 'model', content: 's', stat_delta: [{ key: 'hp', delta: -100 }] },
    ]);
    expect(service.appliedForMessage('m1')?.triggered).toEqual(['down']);
  });

  it('returns null for a ref-only message (its changes are not in the active total)', () => {
    withLedger();
    messages.set([
      { id: 'm1', role: 'model', content: 's', isRefOnly: true, stat_delta: [{ key: 'hp', delta: -10 }] },
    ]);
    expect(service.appliedForMessage('m1')).toBeNull();
  });

  it('returns null when the message carries no stat changes', () => {
    withLedger();
    messages.set([{ id: 'm1', role: 'model', content: 's' }]);
    expect(service.appliedForMessage('m1')).toBeNull();
  });

  it('returns null for an unknown message id', () => {
    withLedger();
    expect(service.appliedForMessage('nope')).toBeNull();
  });

  it('does not console.warn when an event condition throws at render', () => {
    // A condition that compiles but throws at eval would hit evaluateEvents'
    // uncached console.warn path on every chip re-render; the service must route
    // it to a discarded warnings array instead.
    const yaml = [
      'stats:',
      '  hp:',
      '    value: 100',
      '    min: 0',
      '    max: 100',
      'events:',
      '  - condition: "hp.value.nope.crash()"',
      '    type: level',
      '    trigger: boom',
    ].join('\n');
    loadedFiles.set(new Map([[STATS_FILE, yaml]]));
    messages.set([{ id: 'm1', role: 'model', content: 's', stat_delta: [{ key: 'hp', delta: -10 }] }]);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(service.appliedForMessage('m1')).not.toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
