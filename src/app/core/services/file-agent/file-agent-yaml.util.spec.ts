import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { toAgentYaml } from './file-agent-yaml.util';

describe('toAgentYaml', () => {
  it('round-trips nested objects', () => {
    const value = { result: { ok: true, count: 3, items: [1, 2, 3] } };
    const out = toAgentYaml(value);
    expect(parse(out)).toEqual(value);
  });

  it('round-trips unicode (CJK) strings', () => {
    const value = { result: { name: '艾莉絲', summary: '前往酒館找老人' } };
    expect(parse(toAgentYaml(value))).toEqual(value);
  });

  it('keeps multi-line strings readable without escaping newlines', () => {
    const value = { result: { text: 'line one\nline two\nline three' } };
    const out = toAgentYaml(value);
    expect(out).not.toContain('\\n');
    expect(parse(out)).toEqual(value);
  });

  it('quotes strings that start with YAML-significant tokens', () => {
    // `: ` and `- ` at start would otherwise be parsed as mapping/sequence
    // syntax. The serializer must round-trip them losslessly.
    const value = { result: { a: '- item', b: ': value', c: '# not a comment' } };
    expect(parse(toAgentYaml(value))).toEqual(value);
  });

  it('omits JSON syntax noise compared to JSON.stringify', () => {
    const value = { result: { ok: true, n: 1 } };
    const yaml = toAgentYaml(value);
    expect(yaml).not.toContain('{');
    expect(yaml).not.toContain('}');
    expect(yaml).not.toContain('"');
  });

  it('handles arrays of objects (grep-style result)', () => {
    const value = {
      result: {
        matches: [
          { line: 12, text: 'foo bar' },
          { line: 30, text: 'baz qux' },
        ],
      },
    };
    expect(parse(toAgentYaml(value))).toEqual(value);
  });

  it('preserves null and boolean types', () => {
    const value = { result: { found: false, error: null, count: 0 } };
    expect(parse(toAgentYaml(value))).toEqual(value);
  });
});
