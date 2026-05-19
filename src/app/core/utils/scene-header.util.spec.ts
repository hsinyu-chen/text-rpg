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

  it('compacts two time markers in a single message into the range form', () => {
    const content = '[T 12:42]\n...action...\n[T 13:15]';
    expect(extractSceneHeader(content)).toBe('[T 12:42~T 13:15]');
  });

  it('combines base header with compacted multi-marker range', () => {
    const content = '[Act.2 - 西街突襲] [T 12:42] body [T 14:35]';
    expect(extractSceneHeader(content)).toBe('[Act.2 - 西街突襲] [T 12:42~T 14:35]');
  });

  it('still matches `[T...]` without a space after T (legacy parity)', () => {
    // Whitespace after `[T` is optional per TIME_MARKER_GLOBAL_RE; the
    // earlier `\s+` form would have missed this.
    expect(extractSceneHeader('[T大宋 景德三年]')).toBe('[T大宋 景德三年]');
  });
});
