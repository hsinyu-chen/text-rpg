import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseBaseFile } from '../parser';
import { render } from '../renderer';

let tmpDir: string;

function write(name: string, content: string): string {
  const full = join(tmpDir, name);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'prompts-tool-render-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('zero anchor residue', () => {
  it('strips all <!--@...--> anchors from output', () => {
    const src = [
      'pre',
      '<!--@slot:s-->',
      'body',
      '<!--@end-->',
      'post',
      '',
    ].join('\n');
    const f = write('t.md', src);
    const { ast } = parseBaseFile(f);
    const out = render(ast);
    expect(out).not.toContain('<!--@');
    expect(out).toBe('pre\nbody\npost\n');
  });
});

describe('EOL invariant', () => {
  it('output is LF-only and ends with exactly one newline', () => {
    const src = 'line1\nline2\n';
    const f = write('t.md', src);
    const { ast } = parseBaseFile(f);
    const out = render(ast);
    expect(out).not.toContain('\r');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('CRLF input is normalized to LF', () => {
    const f = write('t.md', 'line1\r\nline2\r\n');
    const { ast } = parseBaseFile(f);
    const out = render(ast);
    expect(out).toBe('line1\nline2\n');
  });
});

describe('removed slot', () => {
  it('isRemove=true slot contributes nothing to output', () => {
    const src = ['pre', '<!--@slot:s remove-->', 'post', ''].join('\n');
    const f = write('t.md', src);
    const { ast } = parseBaseFile(f);
    const out = render(ast);
    expect(out).toBe('pre\npost\n');
  });
});
