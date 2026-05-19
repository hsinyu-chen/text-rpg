import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { compose } from './composer';
import {
  parseBaseFileFromString, parseLayerFileFromString, readUtf8Lf,
} from './parser';
import { listMdFilesRecursive, preprocess } from './preprocess';
import { render } from './renderer';
import { config } from './variants.config';
import {
  Diagnostic, LayerAst, Manifest, ManifestEntry, SourceMap, VariantConfig,
} from './types';

export const REPO_ROOT = resolve(__dirname, '..', '..');
export const PARTIALS_SUBDIR = 'partials';

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
      manifest: { entries },
      diagnostics,
    };
  }

  // Track which (layer, lang, fileName) combos a base referenced.
  // After processing all variants, any layer .md file we never read is "orphaned".
  const referencedLayerFiles = new Set<string>();
  const knownLayerLangs = new Map<string, Set<string>>();
  for (const def of Object.values(cfg.variants)) {
    for (const ln of def.layers) {
      const set = knownLayerLangs.get(ln) ?? new Set<string>();
      set.add(def.base);
      knownLayerLangs.set(ln, set);
    }
  }

  // Track which partial files were referenced (transitively) by any host
  // file's preprocess. Partials present on disk but never included are
  // emitted as a warning at the end.
  const referencedPartialFiles = new Set<string>();

  // Cache parsed source files — multiple variants share base + layer dirs
  // (e.g. zh-tw/default and zh-tw/local share the same base; cloud-overrides
  // serves both zh-tw/default and en/default). Re-parsing duplicates
  // diagnostics in the output.
  interface PreprocessEntry {
    processed: string;
    sourceMap: SourceMap;
  }
  const preprocessCache = new Map<string, PreprocessEntry>();
  const cachedPreprocess = (baseFile: string, baseDir: string): PreprocessEntry => {
    let entry = preprocessCache.get(baseFile);
    if (!entry) {
      const raw = readUtf8Lf(baseFile);
      const pre = preprocess(baseFile, raw, { baseDir });
      // Use referencedPartials (includes aggregator-only partials whose body
      // contributes no output lines), not sourceMap.lines.
      for (const p of pre.referencedPartials) referencedPartialFiles.add(p);
      diagnostics.push(...pre.diagnostics);
      entry = { processed: pre.processed, sourceMap: pre.sourceMap };
      preprocessCache.set(baseFile, entry);
    }
    return entry;
  };

  interface BaseParseEntry {
    ast: ReturnType<typeof parseBaseFileFromString>['ast'];
    diagnostics: Diagnostic[];
  }
  const baseCache = new Map<string, BaseParseEntry>();
  const cachedParseBase = (baseFile: string, baseDir: string): BaseParseEntry => {
    let entry = baseCache.get(baseFile);
    if (!entry) {
      const pre = cachedPreprocess(baseFile, baseDir);
      const parsed = parseBaseFileFromString(baseFile, pre.processed, pre.sourceMap, baseDir);
      entry = { ast: parsed.ast, diagnostics: parsed.diagnostics };
      baseCache.set(baseFile, entry);
      diagnostics.push(...parsed.diagnostics);
    }
    return entry;
  };
  const layerCache = new Map<string, ReturnType<typeof parseLayerFileFromString>>();
  const cachedParseLayer = (layerFile: string) => {
    let entry = layerCache.get(layerFile);
    if (!entry) {
      const raw = readUtf8Lf(layerFile);
      // v1: layer files do NOT preprocess. Stray @include lines in a layer
      // file fall through to parser, which flags them as unknown anchors.
      entry = parseLayerFileFromString(layerFile, raw);
      layerCache.set(layerFile, entry);
      diagnostics.push(...entry.diagnostics);
    }
    return entry;
  };

  for (const [variantKey, variantDef] of Object.entries(cfg.variants)) {
    const baseDir = abs(cfg.base_dirs[variantDef.base]);
    if (!existsSync(baseDir)) continue;
    const outputDir = abs(cfg.output_paths[variantKey]);

    for (const fileName of listMdFiles(baseDir)) {
      const baseFile = join(baseDir, fileName);
      const outFile = join(outputDir, fileName);
      const perFile = cfg.per_file[fileName];

      if (perFile?.passthrough) {
        // Passthrough still resolves @include directives (so injection_save and
        // friends can use partials), but skips slot/layer composition.
        const pre = cachedPreprocess(baseFile, baseDir);
        const final = pre.processed.endsWith('\n') ? pre.processed : pre.processed + '\n';
        files.set(outFile, final);
        entries.push({
          variantKey,
          filePath: relRepo(outFile),
          passthrough: true,
        });
        continue;
      }

      const baseParse = cachedParseBase(baseFile, baseDir);

      const layerAsts: Array<{ name: string; ast: LayerAst }> = [];
      for (const layerName of variantDef.layers) {
        const layerDir = abs(cfg.layer_dirs[layerName]);
        const layerFile = join(layerDir, variantDef.base, fileName);
        if (!existsSync(layerFile)) continue;
        referencedLayerFiles.add(layerFile);
        const layerParse = cachedParseLayer(layerFile);
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

  // Orphaned-layer warning: any .md in a layer/<lang>/ dir that no base file
  // referenced. Catches typos (rerun_rules.md under override but base has
  // injection_correction.md → override silently ignored).
  for (const [layerName, langs] of knownLayerLangs) {
    const layerDir = cfg.layer_dirs[layerName];
    if (!layerDir) continue;
    const absLayerDir = abs(layerDir);
    if (!existsSync(absLayerDir)) continue;

    // Stray .md at layer root (forgot the <lang>/ subfolder)
    for (const fileName of listMdFiles(absLayerDir)) {
      diagnostics.push({
        level: 'warning',
        file: relRepo(join(absLayerDir, fileName)),
        message: `stray layer file at layer root (missing <lang>/ subfolder): '${fileName}'`,
      });
    }

    for (const lang of langs) {
      const langDir = join(absLayerDir, lang);
      if (!existsSync(langDir)) continue;
      for (const fileName of listMdFiles(langDir)) {
        const layerFile = join(langDir, fileName);
        if (!referencedLayerFiles.has(layerFile)) {
          diagnostics.push({
            level: 'warning',
            file: relRepo(layerFile),
            message: `orphaned layer file: no base file matches '${fileName}' in ${lang}`,
          });
        }
      }
    }
  }

  // Orphaned-partial warning: any .md under <base>/partials/ that no host
  // file included. Mirrors the orphan-layer check; partials are scanned
  // recursively (subfolders allowed).
  for (const baseDirRel of Object.values(cfg.base_dirs)) {
    const baseDir = abs(baseDirRel);
    if (!existsSync(baseDir)) continue;
    const partialRoot = join(baseDir, PARTIALS_SUBDIR);
    if (!existsSync(partialRoot)) continue;
    for (const fileName of listMdFilesRecursive(partialRoot)) {
      const partialFile = join(partialRoot, fileName);
      if (!referencedPartialFiles.has(partialFile)) {
        diagnostics.push({
          level: 'warning',
          file: relRepo(partialFile),
          message: `orphaned partial: no host file includes 'partials/${fileName}'`,
        });
      }
    }
  }

  const manifest: Manifest = { entries };
  // Normalize absolute file paths in diagnostics to repo-relative so terminal
  // output (and any CI surfaces) stays portable across dev machines.
  const portableDiagnostics = diagnostics.map(d =>
    d.file.startsWith(REPO_ROOT) ? { ...d, file: relRepo(d.file) } : d,
  );
  return { files, manifest, diagnostics: portableDiagnostics };
}

export function validateConfig(cfg: VariantConfig): Diagnostic[] {
  const out: Diagnostic[] = [];

  const isDir = (p: string): boolean => {
    try {
      return statSync(abs(p)).isDirectory();
    } catch {
      return false;
    }
  };

  for (const [key, p] of Object.entries(cfg.base_dirs)) {
    if (!isDir(p)) {
      out.push({
        level: 'error', file: 'variants.config.ts',
        message: `base_dir '${key}' not found or not a directory: ${p}`,
      });
    }
  }
  // layer_dirs may be missing in v1 (empty layer = passthrough). Only warn,
  // and only if path exists as a non-directory (real misconfiguration).
  for (const [key, p] of Object.entries(cfg.layer_dirs)) {
    if (existsSync(abs(p)) && !isDir(p)) {
      out.push({
        level: 'error', file: 'variants.config.ts',
        message: `layer_dir '${key}' is not a directory: ${p}`,
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
