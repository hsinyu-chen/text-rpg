import { describe, expect, it } from 'vitest';
import { extractSceneEvent } from './extract-scene-event.util';
import type { ChatMessage } from '@app/core/models/types';

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    role: 'model',
    content: '',
    ...over,
  };
}

describe('extractSceneEvent', () => {
  it('returns null for user messages', () => {
    expect(extractSceneEvent(msg({ role: 'user', summary: 'wat' }))).toBeNull();
  });

  it('returns null when no summary and all logs empty', () => {
    expect(extractSceneEvent(msg({ summary: '', character_log: [], world_log: [] }))).toBeNull();
  });

  it('returns null when summary is whitespace-only', () => {
    expect(extractSceneEvent(msg({ summary: '   \n  ' }))).toBeNull();
  });

  it('extracts summary and trims it', () => {
    const e = extractSceneEvent(msg({ summary: '  hello world  ' }));
    expect(e?.summary).toBe('hello world');
  });

  it('extracts all four log arrays as copies (not aliases)', () => {
    const src = msg({
      character_log: ['c1'],
      inventory_log: ['i1'],
      quest_log: ['q1'],
      world_log: ['w1'],
    });
    const e = extractSceneEvent(src)!;
    expect(e.character_log).toEqual(['c1']);
    expect(e.inventory_log).toEqual(['i1']);
    expect(e.quest_log).toEqual(['q1']);
    expect(e.world_log).toEqual(['w1']);
    // Mutate source — extracted copy must not be affected.
    src.character_log!.push('mutated');
    expect(e.character_log).toEqual(['c1']);
  });

  it('takes 8-char prefix of id as eventId', () => {
    const e = extractSceneEvent(msg({ id: '12345678-aaaa', summary: 's' }))!;
    expect(e.eventId).toBe('12345678');
    expect(e.messageId).toBe('12345678-aaaa');
  });

  it('finds the first bracket-with-digit header on the content', () => {
    const content = '[T 大宋 景德三年 三月初九 12:42]\n\nstory body';
    const e = extractSceneEvent(msg({ content, summary: 's' }))!;
    expect(e.sceneHeader).toBe('[T 大宋 景德三年 三月初九 12:42]');
  });

  it('falls back to [T ...] time marker when no bracket carries an ASCII digit (pure CJK date)', () => {
    const content = '[T 大宋 景德三年 三月初九]\n\nstory body';
    const e = extractSceneEvent(msg({ content, summary: 's' }))!;
    expect(e.sceneHeader).toBe('[T 大宋 景德三年 三月初九]');
  });

  it('combines base header + time marker when both present', () => {
    const content = '[Act.2 - 西街突襲] [T 大宋 景德三年 三月初九 12:42]\nstory';
    const e = extractSceneEvent(msg({ content, summary: 's' }))!;
    expect(e.sceneHeader).toBe('[Act.2 - 西街突襲] [T 大宋 景德三年 三月初九 12:42]');
  });

  it('returns empty sceneHeader when no digit-bracket and no [T ...] marker exists', () => {
    const e = extractSceneEvent(msg({ content: '[no digits here]\nbody', summary: 's' }))!;
    expect(e.sceneHeader).toBe('');
  });

  it('extracts an event when only a single log array has entries (no summary)', () => {
    const e = extractSceneEvent(msg({ world_log: ['the city catches fire'] }))!;
    expect(e.world_log).toEqual(['the city catches fire']);
    expect(e.summary).toBe('');
  });

  it('handles missing log fields as empty arrays', () => {
    const e = extractSceneEvent(msg({ summary: 's' }))!;
    expect(e.character_log).toEqual([]);
    expect(e.inventory_log).toEqual([]);
    expect(e.quest_log).toEqual([]);
    expect(e.world_log).toEqual([]);
  });
});
