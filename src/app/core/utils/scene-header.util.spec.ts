import { describe, expect, it } from 'vitest';
import {
  extractBaseSceneHeader,
  extractSceneHeader,
  extractTimeMarkerRange,
} from './scene-header.util';

describe('extractBaseSceneHeader', () => {
  it('returns first bracket containing an ASCII digit', () => {
    expect(extractBaseSceneHeader('[Act.2 - foo]\nbody')).toBe('[Act.2 - foo]');
  });

  it('returns "" when no bracket contains an ASCII digit', () => {
    expect(extractBaseSceneHeader('[T 大宋 景德三年 三月初九]\nbody')).toBe('');
  });

  it('returns "" for empty / undefined content', () => {
    expect(extractBaseSceneHeader('')).toBe('');
    expect(extractBaseSceneHeader(undefined)).toBe('');
  });
});

describe('extractTimeMarkerRange', () => {
  it('returns "" when no time marker present', () => {
    expect(extractTimeMarkerRange('plain text')).toBe('');
  });

  it('returns single marker verbatim when only one present', () => {
    expect(extractTimeMarkerRange('intro [T 大宋 12:42] body')).toBe('[T 大宋 12:42]');
  });

  it('compacts multiple markers into start~end range', () => {
    const content = '[T 大宋 三月初九 12:42]\n...\n[T 大宋 三月初九 14:35]';
    expect(extractTimeMarkerRange(content)).toBe('[T 大宋 三月初九 12:42~T 大宋 三月初九 14:35]');
  });
});

describe('extractSceneHeader', () => {
  it('joins base header + time marker with a space when both present', () => {
    const content = '[Act.2 - 西街突襲] [T 大宋 景德三年 三月初九 12:42]\nbody';
    expect(extractSceneHeader(content)).toBe('[Act.2 - 西街突襲] [T 大宋 景德三年 三月初九 12:42]');
  });

  it('falls back to time marker when base header is absent (pure CJK date)', () => {
    expect(extractSceneHeader('[T 大宋 景德三年 三月初九]\nbody')).toBe('[T 大宋 景德三年 三月初九]');
  });

  it('returns just the base header when no time marker exists', () => {
    expect(extractSceneHeader('[Act.2 - foo]\nbody')).toBe('[Act.2 - foo]');
  });

  it('returns "" when neither pattern matches', () => {
    expect(extractSceneHeader('no brackets here')).toBe('');
  });
});
