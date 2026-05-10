import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseBaseFile, parseLayerFile } from '../parser';

let tmpDir: string;

function write(name: string, content: string): string {
  const full = join(tmpDir, name);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'prompts-tool-parser-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('anchor recognition', () => {
  it('recognizes <!--@slot:name--> as slot start', () => {
    const f = write('t.md', '<!--@slot:foo-->\nbody\n<!--@end-->\n');
    const { ast, diagnostics } = parseBaseFile(f);
    expect(diagnostics).toEqual([]);
    expect(ast.slots.has('foo')).toBe(true);
    expect(ast.slots.get('foo')!.body).toBe('body');
  });

  it('recognizes <!--@end--> as slot end', () => {
    const f = write('t.md', 'pre\n<!--@slot:s-->\nx\n<!--@end-->\npost\n');
    const { ast, diagnostics } = parseBaseFile(f);
    expect(diagnostics).toEqual([]);
    expect(ast.blocks).toHaveLength(3);
    expect(ast.blocks[0]).toEqual({ kind: 'invariant', lines: ['pre'] });
    expect(ast.blocks[1]).toEqual({ kind: 'slot-ref', slotId: 's' });
    expect(ast.blocks[2]).toEqual({ kind: 'invariant', lines: ['post'] });
  });

  it('treats `<!-- @system-main-version: 4 -->` (with space) as invariant', () => {
    const f = write('t.md', '<!-- @system-main-version: 4 -->\nx\n');
    const { ast, diagnostics } = parseBaseFile(f);
    expect(diagnostics).toEqual([]);
    expect(ast.slots.size).toBe(0);
    expect(ast.blocks).toHaveLength(1);
    expect((ast.blocks[0] as { lines: string[] }).lines).toEqual([
      '<!-- @system-main-version: 4 -->',
      'x',
    ]);
  });

  it('flags <!--@slott:foo--> (typo) as unknown anchor', () => {
    const f = write('t.md', '<!--@slott:foo-->\n');
    const { diagnostics } = parseBaseFile(f);
    expect(diagnostics.some(d => d.level === 'error' && d.message.includes('unknown anchor'))).toBe(true);
  });
});

describe('heading auto-split', () => {
  it('splits heading from body when first non-empty line matches /^#+\\s/', () => {
    // we test via composer; here just confirm parser stores body verbatim
    const f = write('t.md', '<!--@slot:s-->\n## Title\nline1\n<!--@end-->\n');
    const { ast } = parseBaseFile(f);
    expect(ast.slots.get('s')!.body).toBe('## Title\nline1');
  });

  it('accepts slot with no heading', () => {
    const f = write('t.md', '<!--@slot:s-->\nplain\n<!--@end-->\n');
    const { ast, diagnostics } = parseBaseFile(f);
    expect(diagnostics).toEqual([]);
    expect(ast.slots.get('s')!.body).toBe('plain');
  });
});

describe('fence handling', () => {
  it('allows slot completely outside fence', () => {
    const src = ['<!--@slot:s-->', 'body', '<!--@end-->', '', '```', 'code', '```', ''].join('\n');
    const f = write('t.md', src);
    const { diagnostics } = parseBaseFile(f);
    expect(diagnostics).toEqual([]);
  });

  it('allows slot completely containing a fence', () => {
    const src = [
      '<!--@slot:s-->',
      '```',
      'code',
      '```',
      '<!--@end-->',
      '',
    ].join('\n');
    const f = write('t.md', src);
    const { diagnostics } = parseBaseFile(f);
    expect(diagnostics).toEqual([]);
  });

  it('allows slot completely inside a fence', () => {
    const src = [
      '```',
      '<!--@slot:s-->',
      'inside',
      '<!--@end-->',
      '```',
      '',
    ].join('\n');
    const f = write('t.md', src);
    const { diagnostics } = parseBaseFile(f);
    expect(diagnostics).toEqual([]);
  });

  it('errors on slot crossing fence boundary', () => {
    const src = [
      '<!--@slot:s-->',
      '```',
      'inside',
      '<!--@end-->',
      '```',
    ].join('\n');
    const f = write('t.md', src);
    const { diagnostics } = parseBaseFile(f);
    expect(diagnostics.some(d => d.level === 'error' && d.message.includes('fence'))).toBe(true);
  });
});

describe('op attribute parsing', () => {
  it('recognizes each known op via op="..."', () => {
    for (const op of [
      'heading-replace',
      'content-replace',
      'content-prepend',
      'content-append',
      'full-replace',
    ]) {
      const f = write('layer.md', `<!--@slot:s op="${op}"-->\nbody\n<!--@end-->\n`);
      const { ast, diagnostics } = parseLayerFile(f);
      expect(diagnostics).toEqual([]);
      expect(ast.ops[0].op).toBe(op);
    }
  });

  it('default op is content-replace when omitted', () => {
    const f = write('layer.md', '<!--@slot:s-->\nbody\n<!--@end-->\n');
    const { ast } = parseLayerFile(f);
    expect(ast.ops[0].op).toBe('content-replace');
  });

  it('recognizes bareword `remove` (single-tag, no end)', () => {
    const f = write('layer.md', '<!--@slot:s remove-->\n');
    const { ast, diagnostics } = parseLayerFile(f);
    expect(diagnostics).toEqual([]);
    expect(ast.ops[0].op).toBe('remove');
  });

  it('errors on unknown op value', () => {
    const f = write('layer.md', '<!--@slot:s op="foobar"-->\nbody\n<!--@end-->\n');
    const { diagnostics } = parseLayerFile(f);
    expect(diagnostics.some(d => d.level === 'error' && d.message.includes('unknown op'))).toBe(true);
  });
});

describe('edge cases', () => {
  it('empty slot body is legal', () => {
    const f = write('t.md', '<!--@slot:s-->\n<!--@end-->\n');
    const { ast, diagnostics } = parseBaseFile(f);
    expect(diagnostics).toEqual([]);
    expect(ast.slots.get('s')!.body).toBe('');
  });

  it('errors on duplicate slot id within same file', () => {
    const f = write('t.md', '<!--@slot:s-->\nx\n<!--@end-->\n<!--@slot:s-->\ny\n<!--@end-->\n');
    const { diagnostics } = parseBaseFile(f);
    expect(diagnostics.some(d => d.level === 'error' && d.message.includes('duplicate'))).toBe(true);
  });

  it('errors on nested slot', () => {
    const f = write('t.md', '<!--@slot:outer-->\n<!--@slot:inner-->\nx\n<!--@end-->\n<!--@end-->\n');
    const { diagnostics } = parseBaseFile(f);
    expect(diagnostics.some(d => d.level === 'error' && d.message.includes('nested'))).toBe(true);
  });

  it('errors on slot opened but not closed', () => {
    const f = write('t.md', '<!--@slot:s-->\nbody\n');
    const { diagnostics } = parseBaseFile(f);
    expect(diagnostics.some(d => d.level === 'error' && d.message.includes('opened but never closed'))).toBe(true);
  });

  it('errors on stray <!--@end--> with no open slot', () => {
    const f = write('t.md', '<!--@end-->\n');
    const { diagnostics } = parseBaseFile(f);
    expect(diagnostics.some(d => d.level === 'error' && d.message.includes('unmatched'))).toBe(true);
  });
});

describe('metadata invariant byte-equal', () => {
  it('preserves metadata-marker line verbatim through parse + render', async () => {
    const { render } = await import('../renderer');
    const src = [
      '<!-- @system-main-version: 4 -->',
      '<!-- legacy: kept -->',
      '# Title',
      '',
      'body',
      '',
    ].join('\n');
    const f = write('t.md', src);
    const { ast, diagnostics } = parseBaseFile(f);
    expect(diagnostics).toEqual([]);
    expect(render(ast)).toBe(src);
  });
});
