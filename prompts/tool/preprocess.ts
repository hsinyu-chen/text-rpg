import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { readUtf8Lf } from './parser';
import { Diagnostic, SourceMap } from './types';

export type { SourceMap } from './types';

export const INCLUDE_RE = /^\s*<!--@include:([^>]+?)-->\s*$/;
export const DEFAULT_MAX_INCLUDE_DEPTH = 10;

export interface PreprocessResult {
  processed: string;
  sourceMap: SourceMap;
  diagnostics: Diagnostic[];
}

export interface PreprocessOptions {
  /** Absolute path to the base language directory. `<!--@include:path-->` paths
   *  resolve relative to this; paths that escape it (`..`) or do not start
   *  with `partials/` are rejected. */
  baseDir: string;
  maxDepth?: number;
}

/** Resolve `<!--@include:relative/path.md-->` directives by recursively inlining
 *  partial file contents. Other anchors (slot, op attrs, end) pass through as
 *  plain text — they are interpreted by the parser after preprocess.
 *
 *  Cycle detection uses the parent chain (not a visited set), so diamond
 *  inclusion (host → A → C, host → B → C) is legal; only a true cycle
 *  (host → A → B → A) is flagged. */
export function preprocess(
  filePath: string,
  raw: string,
  opts: PreprocessOptions,
): PreprocessResult {
  const diagnostics: Diagnostic[] = [];
  const outLines: string[] = [];
  const outMap: SourceMap['lines'] = [];
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_INCLUDE_DEPTH;
  const baseDir = resolve(opts.baseDir);

  const expand = (
    file: string,
    content: string,
    chain: string[],
  ): void => {
    const stripped = content.endsWith('\n') ? content.slice(0, -1) : content;
    const lines = stripped.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const m = line.match(INCLUDE_RE);
      if (!m) {
        outLines.push(line);
        outMap.push({ file, line: lineNum });
        continue;
      }

      const rawPath = m[1].trim();
      const targetAbs = resolvePartialPath(rawPath, baseDir);
      if (!targetAbs) {
        diagnostics.push({
          level: 'error', file, line: lineNum,
          message: `@include path must start with 'partials/' and stay within the base dir: '${rawPath}'`,
        });
        continue;
      }
      if (!existsSync(targetAbs)) {
        const relTarget = relative(baseDir, targetAbs).replace(/\\/g, '/');
        diagnostics.push({
          level: 'error', file, line: lineNum,
          message: `@include target not found: '${rawPath}' (resolved: ${relTarget})`,
        });
        continue;
      }
      if (chain.includes(targetAbs)) {
        const cycle = [...chain, targetAbs]
          .map(p => p === filePath ? '<host>' : relative(baseDir, p).replace(/\\/g, '/'))
          .join(' → ');
        diagnostics.push({
          level: 'error', file, line: lineNum,
          message: `@include cycle detected: ${cycle}`,
        });
        continue;
      }
      if (chain.length + 1 > maxDepth) {
        diagnostics.push({
          level: 'error', file, line: lineNum,
          message: `@include depth exceeds ${maxDepth} (chain length ${chain.length + 1})`,
        });
        continue;
      }

      const partialContent = readUtf8Lf(targetAbs);
      expand(targetAbs, partialContent, [...chain, targetAbs]);
    }
  };

  expand(filePath, raw, [filePath]);

  const processed = outLines.length === 0 ? '' : outLines.join('\n') + '\n';
  return {
    processed,
    sourceMap: { lines: outMap },
    diagnostics,
  };
}

const PARTIALS_PREFIX = 'partials/';

function resolvePartialPath(rawPath: string, baseDir: string): string | null {
  if (isAbsolute(rawPath)) return null;
  if (!rawPath.startsWith(PARTIALS_PREFIX)) return null;
  const abs = resolve(baseDir, rawPath);
  const rel = relative(baseDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  if (rel.split(sep).includes('..')) return null;
  // Final guard: the resolved path must remain within partials/
  const normRel = rel.replace(/\\/g, '/');
  if (!normRel.startsWith(PARTIALS_PREFIX)) return null;
  return abs;
}

/** Format a (host file, processed line) pair using a source map. Returns the
 *  original (file, line) when the line came from the host, or a "via partial"
 *  reference when the line was inlined from a partial. */
export function formatSourceLocation(
  hostFile: string,
  processedLine: number,
  sourceMap: SourceMap | undefined,
  baseDir: string,
): { file: string; line: number; via?: string } {
  if (!sourceMap || processedLine < 1 || processedLine > sourceMap.lines.length) {
    return { file: hostFile, line: processedLine };
  }
  const entry = sourceMap.lines[processedLine - 1];
  if (entry.file === hostFile) {
    return { file: hostFile, line: entry.line };
  }
  const partialRel = relative(baseDir, entry.file).replace(/\\/g, '/');
  return {
    file: hostFile,
    line: processedLine,
    via: `${partialRel}:${entry.line}`,
  };
}

/** Recursively list .md files under `dir`, returning forward-slash paths
 *  relative to `dir`. */
export function listMdFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (sub: string): void => {
    const entries = readdirSync(resolve(dir, sub), { withFileTypes: true });
    for (const ent of entries) {
      const child = sub ? `${sub}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(child);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        out.push(child);
      }
    }
  };
  walk('');
  return out.sort();
}
