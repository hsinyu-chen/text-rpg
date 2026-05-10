import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPipeline, validateConfig } from '../pipeline';
import { VariantConfig } from '../types';

let tmpDir: string;

function write(rel: string, content: string): void {
  const full = join(tmpDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'prompts-tool-pipeline-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function configIn(rel: (p: string) => string): VariantConfig {
  return {
    base_dirs: { 'zh-tw': rel('base/zh-tw') },
    layer_dirs: { cloud: rel('layers/cloud') },
    variants: { 'zh-tw/default': { base: 'zh-tw', layers: ['cloud'] } },
    output_paths: { 'zh-tw/default': rel('out') },
    per_file: {},
  };
}

describe('end-to-end build', () => {
  it('runs with base + cloud override and produces composed file', () => {
    const rel = (p: string) => join(tmpDir, p);
    write('base/zh-tw/x.md', 'pre\n<!--@slot:s-->\nbase\n<!--@end-->\npost\n');
    write('layers/cloud/zh-tw/x.md', '<!--@slot:s-->\noverride\n<!--@end-->\n');
    const cfg = configIn(rel);
    const out = runPipeline(cfg);

    expect(out.diagnostics.filter(d => d.level === 'error')).toEqual([]);
    const outFile = resolve(rel('out/x.md'));
    expect(out.files.has(outFile)).toBe(true);
    expect(out.files.get(outFile)).toBe('pre\noverride\npost\n');
  });

  it('idempotent: same source produces byte-equal output across two builds', () => {
    const rel = (p: string) => join(tmpDir, p);
    write('base/zh-tw/x.md', 'pre\n<!--@slot:s-->\nbase\n<!--@end-->\n');
    write('layers/cloud/zh-tw/x.md', '<!--@slot:s-->\nover\n<!--@end-->\n');
    const cfg = configIn(rel);
    const a = runPipeline(cfg);
    const b = runPipeline(cfg);
    expect([...a.files.entries()]).toEqual([...b.files.entries()]);
    expect(a.manifest.entries).toEqual(b.manifest.entries);
  });

  it('passthrough file copies raw and is recorded as passthrough in manifest', () => {
    const rel = (p: string) => join(tmpDir, p);
    write('base/zh-tw/note.md', 'literal\nfile\n');
    const cfg: VariantConfig = {
      ...configIn(rel),
      per_file: { 'note.md': { passthrough: true } },
    };
    const out = runPipeline(cfg);
    const outFile = resolve(rel('out/note.md'));
    expect(out.files.get(outFile)).toBe('literal\nfile\n');
    const entry = out.manifest.entries.find(e => e.filePath.endsWith('note.md'))!;
    expect(entry.passthrough).toBe(true);
    expect(entry.slots).toBeUndefined();
  });

  it('manifest records final source and op history per slot', () => {
    const rel = (p: string) => join(tmpDir, p);
    write('base/zh-tw/x.md', '<!--@slot:s-->\nbase\n<!--@end-->\n');
    write('layers/cloud/zh-tw/x.md', '<!--@slot:s-->\nover\n<!--@end-->\n');
    const cfg = configIn(rel);
    const out = runPipeline(cfg);
    const entry = out.manifest.entries[0];
    expect(entry.slots).toBeDefined();
    const slot = entry.slots!.find(s => s.id === 's')!;
    expect(slot.layers).toEqual([{ layer: 'cloud', op: 'content-replace' }]);
  });
});

describe('config validation', () => {
  it('errors on undefined layer reference', () => {
    const cfg: VariantConfig = {
      base_dirs: { x: tmpDir },
      layer_dirs: {},
      variants: { 'x/y': { base: 'x', layers: ['missing'] } },
      output_paths: { 'x/y': join(tmpDir, 'out') },
      per_file: {},
    };
    const diags = validateConfig(cfg);
    expect(diags.some(d => d.level === 'error' && d.message.includes('undefined layer'))).toBe(true);
  });

  it('errors on undefined base reference', () => {
    const cfg: VariantConfig = {
      base_dirs: {},
      layer_dirs: {},
      variants: { 'x/y': { base: 'missing', layers: [] } },
      output_paths: { 'x/y': join(tmpDir, 'out') },
      per_file: {},
    };
    const diags = validateConfig(cfg);
    expect(diags.some(d => d.level === 'error' && d.message.includes('undefined base'))).toBe(true);
  });

  it('errors on output_path conflict', () => {
    const cfg: VariantConfig = {
      base_dirs: { a: tmpDir },
      layer_dirs: {},
      variants: {
        'a/x': { base: 'a', layers: [] },
        'a/y': { base: 'a', layers: [] },
      },
      output_paths: {
        'a/x': join(tmpDir, 'out'),
        'a/y': join(tmpDir, 'out'),
      },
      per_file: {},
    };
    const diags = validateConfig(cfg);
    expect(diags.some(d => d.level === 'error' && d.message.includes('output_path conflict'))).toBe(true);
  });
});

describe('orphaned layer file warning', () => {
  it('warns when a layer .md has no matching base file (typo / dangling override)', () => {
    const rel = (p: string) => join(tmpDir, p);
    write('base/zh-tw/x.md', '<!--@slot:s-->\nbase\n<!--@end-->\n');
    write('layers/cloud/zh-tw/x.md', '<!--@slot:s-->\nover\n<!--@end-->\n');
    write('layers/cloud/zh-tw/typo.md', '<!--@slot:t-->\noops\n<!--@end-->\n');
    const cfg = configIn(rel);
    const out = runPipeline(cfg);
    expect(out.diagnostics.some(d => d.level === 'warning' && d.message.includes('orphaned'))).toBe(true);
  });
});

describe('idempotent on existing output', () => {
  it('rebuild over existing output produces same bytes', () => {
    const rel = (p: string) => join(tmpDir, p);
    write('base/zh-tw/x.md', '<!--@slot:s-->\nbase\n<!--@end-->\n');
    const cfg = configIn(rel);
    const a = runPipeline(cfg);
    // simulate first write
    const outFile = resolve(rel('out/x.md'));
    mkdirSync(rel('out'), { recursive: true });
    writeFileSync(outFile, a.files.get(outFile)!, 'utf8');
    // second build
    const b = runPipeline(cfg);
    const onDisk = readFileSync(outFile, 'utf8');
    expect(onDisk).toBe(b.files.get(outFile));
  });
});
