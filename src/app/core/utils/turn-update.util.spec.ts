import { describe, expect, it } from 'vitest';
import { ChatMessage } from '@app/core/models/types';
import { hasTurnUpdate } from './turn-update.util';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return { id: 'm1', role: 'model', content: '', ...overrides } as ChatMessage;
}

describe('hasTurnUpdate', () => {
  it('returns true when only a summary is present', () => {
    expect(hasTurnUpdate(msg({ summary: 'recap' }))).toBe(true);
  });

  it('returns true when only a character_log entry is present', () => {
    expect(hasTurnUpdate(msg({ character_log: ['Pete is wounded'] }))).toBe(true);
  });

  it('returns true when only an inventory_log entry is present', () => {
    expect(hasTurnUpdate(msg({ inventory_log: ['+1 torch'] }))).toBe(true);
  });

  it('returns true when only a quest_log entry is present', () => {
    expect(hasTurnUpdate(msg({ quest_log: ['Find the relic'] }))).toBe(true);
  });

  it('returns true when only a world_log entry is present', () => {
    expect(hasTurnUpdate(msg({ world_log: ['The bridge collapsed'] }))).toBe(true);
  });

  it('returns true when only a correction is present', () => {
    expect(hasTurnUpdate(msg({ correction: 'retconned the door' }))).toBe(true);
  });

  it('returns false for a message with no turn-update content', () => {
    expect(hasTurnUpdate(msg({}))).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasTurnUpdate(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(hasTurnUpdate(null)).toBe(false);
  });

  it('returns false when logs are present but empty arrays', () => {
    expect(hasTurnUpdate(msg({
      character_log: [],
      inventory_log: [],
      quest_log: [],
      world_log: [],
    }))).toBe(false);
  });
});
