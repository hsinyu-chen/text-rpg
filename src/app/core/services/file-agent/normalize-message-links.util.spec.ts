import { describe, expect, it } from 'vitest';
import { normalizeMessageLinks } from './normalize-message-links.util';

const G = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
const G2 = '11111111-2222-3333-4444-555555555555';

describe('normalizeMessageLinks', () => {
  it('wraps a raw GUID when the line contains "訊息"', () => {
    expect(normalizeMessageLinks(`目標訊息 ${G} 已找到`))
      .toBe(`目標訊息 [${G}](app://message/${G}) 已找到`);
  });

  it('wraps a raw GUID when the line contains "message" (case-insensitive)', () => {
    expect(normalizeMessageLinks(`Found Message ${G}.`))
      .toBe(`Found Message [${G}](app://message/${G}).`);
  });

  it('leaves GUIDs alone when neither keyword is on the line', () => {
    const text = `Book id ${G}`;
    expect(normalizeMessageLinks(text)).toBe(text);
  });

  it('does not double-wrap a GUID already inside an app://message link', () => {
    const text = `See message [${G}](app://message/${G})`;
    expect(normalizeMessageLinks(text)).toBe(text);
  });

  it('does not wrap a GUID that is the URL part of an existing link', () => {
    const text = `See message [前面那則](app://message/${G})`;
    expect(normalizeMessageLinks(text)).toBe(text);
  });

  it('handles multiple GUIDs on the same qualifying line', () => {
    const out = normalizeMessageLinks(`訊息 ${G} 與 ${G2} 衝突`);
    expect(out).toBe(`訊息 [${G}](app://message/${G}) 與 [${G2}](app://message/${G2}) 衝突`);
  });

  it('processes each line independently', () => {
    const input = [
      `Random Book ${G}`,
      `Reference message ${G2}`,
    ].join('\n');
    const out = normalizeMessageLinks(input);
    expect(out).toBe([
      `Random Book ${G}`,
      `Reference message [${G2}](app://message/${G2})`,
    ].join('\n'));
  });

  it('returns empty / undefined input unchanged', () => {
    expect(normalizeMessageLinks('')).toBe('');
  });

  it('returns empty string for non-string input (LLM hallucinated arg)', () => {
    // Defends against parseActionsFromOutput casting via `as unknown` —
    // the runtime arg shape is not guaranteed.
    expect(normalizeMessageLinks(undefined as unknown as string)).toBe('');
    expect(normalizeMessageLinks(null as unknown as string)).toBe('');
    expect(normalizeMessageLinks({ text: G } as unknown as string)).toBe('');
  });

  it('wraps a GUID inside parentheses on a qualifying line', () => {
    expect(normalizeMessageLinks(`(see message ${G})`))
      .toBe(`(see message [${G}](app://message/${G}))`);
  });

  it('skips GUIDs that are already part of any URL path', () => {
    // Generic `(?<!/)` lookbehind protects every URL scheme, not just
    // app://message/ — prevents nested-link mangling on a GUID-shaped
    // segment inside app://file/ / app://hint/ / etc.
    const text = `see message [foo](app://file/${G})`;
    expect(normalizeMessageLinks(text)).toBe(text);
  });
});
