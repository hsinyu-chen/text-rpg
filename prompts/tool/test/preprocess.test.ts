import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { preprocess, INCLUDE_RE, DEFAULT_MAX_INCLUDE_DEPTH } from '../preprocess';

let tmpDir: string;
let baseDir: string;
let partialRoot: string;

function write(rel: string, content: string): string {
  const full = join(tmpDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'prompts-preprocess-'));
  baseDir = tmpDir;
  partialRoot = join(baseDir, 'partials');
  mkdirSync(partialRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('INCLUDE_RE', () => {
  it('matches a bare @include line', () => {
    expect('<!--@include:partials/foo.md-->'.match(INCLUDE_RE)?.[1]).toBe('partials/foo.md');
  });

  it('matches @include with leading/trailing whitespace', () => {
    expect('  <!--@include:partials/nested/foo.md-->  '.match(INCLUDE_RE)?.[1])
      .toBe('partials/nested/foo.md');
  });

  it('does not match @include inside a line of other text', () => {
    expect('prefix <!--@include:partials/foo.md-->'.match(INCLUDE_RE)).toBeNull();
  });
});

describe('basic substitution', () => {
  it('inlines a single partial', () => {
    write('partials/a.md', 'partial-body\n');
    const host = write('host.md', 'before\n<!--@include:partials/a.md-->\nafter\n');
    const { processed, diagnostics } = preprocess(
      host,
      'before\n<!--@include:partials/a.md-->\nafter\n',
      { baseDir },
    );
    expect(diagnostics).toEqual([]);
    expect(processed).toBe('before\npartial-body\nafter\n');
  });

  it('produces a source map mapping processed lines to original (file, line)', () => {
    write('partials/a.md', 'p1\np2\n');
    const host = write('host.md', 'h1\n<!--@include:partials/a.md-->\nh3\n');
    const { sourceMap } = preprocess(
      host, 'h1\n<!--@include:partials/a.md-->\nh3\n', { baseDir },
    );
    expect(sourceMap.lines).toEqual([
      { file: host, line: 1 },
      { file: join(partialRoot, 'a.md'), line: 1 },
      { file: join(partialRoot, 'a.md'), line: 2 },
      { file: host, line: 3 },
    ]);
  });

  it('partial without trailing newline is normalized', () => {
    write('partials/a.md', 'no-trailing');
    const host = write('host.md', '<!--@include:partials/a.md-->\n');
    const { processed } = preprocess(
      host, '<!--@include:partials/a.md-->\n', { baseDir },
    );
    expect(processed).toBe('no-trailing\n');
  });
});

describe('recursive include', () => {
  it('inlines partials transitively (host → A → B)', () => {
    write('partials/a.md', 'a-pre\n<!--@include:partials/b.md-->\na-post\n');
    write('partials/b.md', 'b-body\n');
    const host = write('host.md', '<!--@include:partials/a.md-->\n');
    const { processed, diagnostics } = preprocess(
      host, '<!--@include:partials/a.md-->\n', { baseDir },
    );
    expect(diagnostics).toEqual([]);
    expect(processed).toBe('a-pre\nb-body\na-post\n');
  });
});

describe('diamond include (legal)', () => {
  it('allows the same partial to be included twice via different chains', () => {
    write('partials/a.md', '<!--@include:partials/c.md-->\n');
    write('partials/b.md', '<!--@include:partials/c.md-->\n');
    write('partials/c.md', 'c-body\n');
    const host = write('host.md', '<!--@include:partials/a.md-->\n<!--@include:partials/b.md-->\n');
    const { processed, diagnostics } = preprocess(
      host, '<!--@include:partials/a.md-->\n<!--@include:partials/b.md-->\n', { baseDir },
    );
    expect(diagnostics.filter(d => d.level === 'error')).toEqual([]);
    expect(processed).toBe('c-body\nc-body\n');
  });
});

describe('cycle detection', () => {
  it('flags a cycle (host → A → B → A) and emits an error with the chain', () => {
    write('partials/a.md', '<!--@include:partials/b.md-->\n');
    write('partials/b.md', '<!--@include:partials/a.md-->\n');
    const host = write('host.md', '<!--@include:partials/a.md-->\n');
    const { diagnostics } = preprocess(
      host, '<!--@include:partials/a.md-->\n', { baseDir },
    );
    const errors = diagnostics.filter(d => d.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('cycle detected');
    expect(errors[0].message).toContain('a.md');
    expect(errors[0].message).toContain('b.md');
  });

  it('flags a self-cycle (partial including itself)', () => {
    write('partials/a.md', '<!--@include:partials/a.md-->\n');
    const host = write('host.md', '<!--@include:partials/a.md-->\n');
    const { diagnostics } = preprocess(
      host, '<!--@include:partials/a.md-->\n', { baseDir },
    );
    expect(diagnostics.some(d => d.level === 'error' && d.message.includes('cycle'))).toBe(true);
  });
});

describe('depth limit', () => {
  it('emits an error when include chain exceeds maxDepth', () => {
    write('partials/a.md', '<!--@include:partials/b.md-->\n');
    write('partials/b.md', '<!--@include:partials/c.md-->\n');
    write('partials/c.md', '<!--@include:partials/d.md-->\n');
    write('partials/d.md', '<!--@include:partials/e.md-->\n');
    write('partials/e.md', 'leaf\n');
    const host = write('host.md', '<!--@include:partials/a.md-->\n');
    const { diagnostics } = preprocess(
      host, '<!--@include:partials/a.md-->\n', { baseDir, maxDepth: 3 },
    );
    expect(diagnostics.some(d => d.level === 'error' && d.message.includes('depth exceeds'))).toBe(true);
  });

  it('default depth allows reasonable nesting', () => {
    expect(DEFAULT_MAX_INCLUDE_DEPTH).toBeGreaterThanOrEqual(10);
  });
});

describe('path validation', () => {
  it('rejects @include path escaping the base dir', () => {
    write('sneaky.md', 'evil');
    const host = write('host.md', '<!--@include:partials/../sneaky.md-->\n');
    const { diagnostics } = preprocess(
      host, '<!--@include:partials/../sneaky.md-->\n', { baseDir },
    );
    expect(diagnostics.some(d => d.level === 'error')).toBe(true);
  });

  it('rejects @include path without partials/ prefix', () => {
    write('host-sibling.md', 'evil');
    const host = write('host.md', '<!--@include:host-sibling.md-->\n');
    const { diagnostics } = preprocess(
      host, '<!--@include:host-sibling.md-->\n', { baseDir },
    );
    expect(diagnostics.some(d =>
      d.level === 'error' && d.message.includes('partials/'),
    )).toBe(true);
  });

  it('rejects absolute @include path', () => {
    const abs = join(partialRoot, 'x.md');
    const host = write('host.md', `<!--@include:${abs}-->\n`);
    const { diagnostics } = preprocess(
      host, `<!--@include:${abs}-->\n`, { baseDir },
    );
    expect(diagnostics.some(d => d.level === 'error')).toBe(true);
  });

  it('emits an error when partial file does not exist', () => {
    const host = write('host.md', '<!--@include:partials/missing.md-->\n');
    const { diagnostics } = preprocess(
      host, '<!--@include:partials/missing.md-->\n', { baseDir },
    );
    expect(diagnostics.some(d => d.level === 'error' && d.message.includes('not found'))).toBe(true);
  });
});

describe('plain-text passthrough of foreign anchors', () => {
  it('preserves <!--@slot-->, <!--@end-->, op="..." attrs inside partials verbatim', () => {
    const partialBody = '<!--@slot:foo-->\nbody\n<!--@end-->\n';
    write('partials/with-slot.md', partialBody);
    const host = write('host.md', '<!--@include:partials/with-slot.md-->\n');
    const { processed, diagnostics } = preprocess(
      host, '<!--@include:partials/with-slot.md-->\n', { baseDir },
    );
    // Step 1 leaves slot/end markers as plain text — parser interprets them.
    expect(diagnostics.filter(d => d.level === 'error')).toEqual([]);
    expect(processed).toBe(partialBody);
  });
});

describe('include directive matches only standalone lines', () => {
  it('does not substitute @include embedded in another sentence', () => {
    write('partials/a.md', 'A-BODY\n');
    const host = write('host.md', 'see <!--@include:partials/a.md--> inline\n');
    const { processed } = preprocess(
      host, 'see <!--@include:partials/a.md--> inline\n', { baseDir },
    );
    expect(processed).toContain('see <!--@include:partials/a.md--> inline');
    expect(processed).not.toContain('A-BODY');
  });
});
