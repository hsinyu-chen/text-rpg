import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { compose } from './composer';
import { parseBaseFile, parseLayerFile } from './parser';
import { render } from './renderer';
import { config } from './variants.config';
import {
  Diagnostic, LayerAst, Manifest, ManifestEntry, VariantConfig,
} from './types';

export const REPO_ROOT = resolve(__dirname, '..', '..');

export interface PipelineOutput {
  files: Map<string, string>;
  manifest: Manifest;
  diagnostics: Diagnostic[];
}

export function runPipeline(cfg: VariantConfig = config): PipelineOutput {
  const diagnostics: Diagnostic[] = [];
  const files = new Map<string, string>();
  const entries: ManifestEntry[] = [];

  diagnostics.push(...validateConfig(cfg));
  if (diagnostics.some(d => d.level === 'error')) {
    return {
      files,
      manifest: { generatedAt: '', entries },
      diagnostics,
    };
  }

  for (const [variantKey, variantDef] of Object.entries(cfg.variants)) {
    const baseDir = abs(cfg.base_dirs[variantDef.base]);
    if (!existsSync(baseDir)) continue;
    const outputDir = abs(cfg.output_paths[variantKey]);

    for (const fileName of listMdFiles(baseDir)) {
      const baseFile = join(baseDir, fileName);
      const outFile = join(outputDir, fileName);
      const perFile = cfg.per_file[fileName];

      if (perFile?.passthrough) {
        const raw = readFileSync(baseFile, 'utf8').replace(/\r\n/g, '\n');
        const final = raw.endsWith('\n') ? raw : raw + '\n';
        files.set(outFile, final);
        entries.push({
          variantKey,
          filePath: relRepo(outFile),
          passthrough: true,
        });
        continue;
      }

      const baseParse = parseBaseFile(baseFile);
      diagnostics.push(...baseParse.diagnostics);

      const layerAsts: Array<{ name: string; ast: LayerAst }> = [];
      for (const layerName of variantDef.layers) {
        const layerDir = abs(cfg.layer_dirs[layerName]);
        const layerFile = join(layerDir, variantDef.base, fileName);
        if (!existsSync(layerFile)) continue;
        const layerParse = parseLayerFile(layerFile);
        diagnostics.push(...layerParse.diagnostics);
        layerAsts.push({ name: layerName, ast: layerParse.ast });
      }

      const composeResult = compose(baseParse.ast, layerAsts);
      diagnostics.push(...composeResult.diagnostics);

      const finalText = render(composeResult.finalAst);
      files.set(outFile, finalText);

      entries.push({
        variantKey,
        filePath: relRepo(outFile),
        passthrough: false,
        slots: composeResult.manifest.map(s => ({
          ...s,
          finalSource: relRepo(s.finalSource),
        })),
      });
    }
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    entries,
  };
  return { files, manifest, diagnostics };
}

export function validateConfig(cfg: VariantConfig): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const [key, p] of Object.entries(cfg.base_dirs)) {
    if (!existsSync(abs(p))) {
      out.push({
        level: 'error', file: 'variants.config.ts',
        message: `base_dir '${key}' not found: ${p}`,
      });
    }
  }

  for (const [vKey, def] of Object.entries(cfg.variants)) {
    if (!cfg.base_dirs[def.base]) {
      out.push({
        level: 'error', file: 'variants.config.ts',
        message: `variant '${vKey}' references undefined base: '${def.base}'`,
      });
    }
    for (const ln of def.layers) {
      if (!cfg.layer_dirs[ln]) {
        out.push({
          level: 'error', file: 'variants.config.ts',
          message: `variant '${vKey}' references undefined layer: '${ln}'`,
        });
      }
    }
    if (!cfg.output_paths[vKey]) {
      out.push({
        level: 'error', file: 'variants.config.ts',
        message: `variant '${vKey}' has no output_path`,
      });
    }
  }

  const seen = new Map<string, string>();
  for (const [vKey, op] of Object.entries(cfg.output_paths)) {
    if (seen.has(op)) {
      out.push({
        level: 'error', file: 'variants.config.ts',
        message: `output_path conflict: '${vKey}' and '${seen.get(op)}' both target '${op}'`,
      });
    }
    seen.set(op, vKey);
  }

  return out;
}

function abs(p: string): string {
  return resolve(REPO_ROOT, p);
}

function relRepo(p: string): string {
  return relative(REPO_ROOT, p).replace(/\\/g, '/');
}

function listMdFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .filter(name => statSync(join(dir, name)).isFile())
    .sort();
}

export function manifestEntriesEqual(a: Manifest, b: Manifest): boolean {
  return JSON.stringify(a.entries) === JSON.stringify(b.entries);
}
