/**
 * Build-time generator for agent-hints.manifest.generated.ts.
 *
 * Scans src/**\/*.component.html for `appAgentHint="path"` attributes (+
 * `(hintActivate)` events), reconstructs a path tree, and writes a TS file
 * the runtime registry merges with manifest.base.ts.
 *
 * All checks emit WARNINGS to stderr — never exits non-zero on findings.
 * Exits non-zero only on hard runtime failures (parser crash, IO error).
 *
 * Run: npm run hints:build
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { glob } from 'glob';
import { parseTemplate } from '@angular/compiler';

interface HintBinding {
  path: string;
  activatable: boolean;
  file: string;
  line: number;
  col: number;
  isDynamic: boolean;
}

interface ManifestEntry {
  id: string;
  activatable?: boolean;
  children?: ManifestEntry[];
}

const repoRoot = process.cwd();
const SRC_GLOB = 'src/**/*.component.html';
const OUTPUT = 'src/app/core/services/agent-hints/agent-hints.manifest.generated.ts';
const BASE_FILE = 'src/app/core/services/agent-hints/agent-hints.manifest.base.ts';
const EN_DICT = 'src/app/core/i18n/dictionaries/en.ts';
const ZHTW_DICT = 'src/app/core/i18n/dictionaries/zh-tw.ts';

const warnings: string[] = [];
function warn(message: string): void {
  warnings.push(message);
}

async function main(): Promise<void> {
  const files = await glob(SRC_GLOB, { cwd: repoRoot, absolute: true });
  const bindings: HintBinding[] = [];

  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const result = parseTemplate(html, file, { preserveWhitespaces: false });
    if (result.errors?.length) {
      for (const e of result.errors) warn(`[parse] ${relative(repoRoot, file)}: ${e.msg ?? String(e)}`);
      continue;
    }
    walk(result.nodes, file, bindings);
  }

  // Collapse to one record per path (activatable=true wins on duplicates).
  const pathInfo = new Map<string, { activatable: boolean; isDynamic: boolean }>();
  for (const b of bindings) {
    if (b.isDynamic) {
      warn(`[dynamic-path] ${relative(repoRoot, b.file)}:${b.line}:${b.col} — [appAgentHint] is bound, registry cannot statically register "${b.path}"`);
      continue;
    }
    const prev = pathInfo.get(b.path);
    pathInfo.set(b.path, {
      activatable: b.activatable || (prev?.activatable ?? false),
      isDynamic: false,
    });
  }

  // Auto-fill intermediate container nodes (e.g. 'a/b' when only 'a/b/c' was seen).
  for (const path of [...pathInfo.keys()]) {
    const segs = path.split('/');
    for (let i = 1; i < segs.length; i++) {
      const ancestor = segs.slice(0, i).join('/');
      if (!pathInfo.has(ancestor)) pathInfo.set(ancestor, { activatable: false, isDynamic: false });
    }
  }

  const generatedTree = buildTree(pathInfo);

  // Conflict check: same path in base + generated → warning.
  const basePaths = await loadBasePaths();
  for (const path of basePaths.keys()) {
    if (pathInfo.has(path)) {
      warn(`[conflict] ${path} exists in BOTH manifest.base.ts and the AST scan. Generated wins; remove from base.`);
    }
  }

  // i18n completeness check (warning only).
  await checkI18nKeys([...pathInfo.keys(), ...basePaths.keys()]);

  // Write output.
  const outputPath = resolve(repoRoot, OUTPUT);
  writeFileSync(outputPath, renderGenerated(generatedTree), 'utf8');
  console.log(`Wrote ${OUTPUT} (${pathInfo.size} paths from ${files.length} templates)`);

  // Surface warnings on stderr; never exit non-zero.
  if (warnings.length) {
    process.stderr.write(`\n${warnings.length} warning(s):\n`);
    for (const w of warnings) process.stderr.write(`  ${w}\n`);
  }
}

function walk(nodes: readonly unknown[], file: string, out: HintBinding[]): void {
  for (const raw of nodes) {
    const node = raw as {
      name?: string;
      attributes?: { name: string; value: string; sourceSpan?: { start: { line: number; col: number } } }[];
      inputs?: { name: string; value: { source?: string }; sourceSpan?: { start: { line: number; col: number } } }[];
      outputs?: { name: string }[];
      startSourceSpan?: { start: { line: number; col: number } };
      children?: unknown[];
      branches?: { children?: unknown[] }[];
      cases?: { children?: unknown[] }[];
      body?: unknown[];
    };

    const staticHint = node.attributes?.find((a) => a.name === 'appAgentHint');
    const boundHint = node.inputs?.find((i) => i.name === 'appAgentHint');
    const hintActivate = node.outputs?.find((o) => o.name === 'hintActivate');

    if (staticHint || boundHint || hintActivate) {
      const span = node.startSourceSpan?.start;
      out.push({
        path: staticHint?.value ?? boundHint?.value?.source ?? '',
        activatable: !!hintActivate,
        file,
        line: (span?.line ?? 0) + 1,
        col: (span?.col ?? 0) + 1,
        isDynamic: !!boundHint && !staticHint,
      });
    }

    if (node.children?.length) walk(node.children, file, out);
    if (node.branches) for (const b of node.branches) if (b.children?.length) walk(b.children, file, out);
    if (node.cases) for (const c of node.cases) if (c.children?.length) walk(c.children, file, out);
    if (node.body?.length) walk(node.body, file, out);
  }
}

function buildTree(pathInfo: Map<string, { activatable: boolean }>): ManifestEntry[] {
  type Node = { id: string; activatable?: boolean; childMap: Map<string, Node> };
  const roots = new Map<string, Node>();

  const sortedPaths = [...pathInfo.keys()].sort();
  for (const path of sortedPaths) {
    const segs = path.split('/');
    let level = roots;
    let node: Node | undefined;
    for (const seg of segs) {
      node = level.get(seg);
      if (!node) {
        node = { id: seg, childMap: new Map() };
        level.set(seg, node);
      }
      level = node.childMap;
    }
    if (node && pathInfo.get(path)!.activatable) node.activatable = true;
  }

  function toEntries(nodes: Iterable<Node>): ManifestEntry[] {
    const arr = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
    return arr.map((n) => {
      const entry: ManifestEntry = { id: n.id };
      if (n.activatable) entry.activatable = true;
      if (n.childMap.size) entry.children = toEntries(n.childMap.values());
      return entry;
    });
  }
  return toEntries(roots.values());
}

function renderGenerated(tree: ManifestEntry[]): string {
  const banner = `// AUTO-GENERATED by tools/build-hints.ts — DO NOT EDIT.\n// Run \`npm run hints:build\` to regenerate after touching templates.\n`;
  const body = `import type { AgentHintEntry } from './agent-hints.types';\n\nexport const GENERATED_HINTS: AgentHintEntry[] = ${stringifyEntries(tree, 0)};\n`;
  return banner + '\n' + body;
}

function stringifyEntries(entries: ManifestEntry[], indent: number): string {
  if (!entries.length) return '[]';
  const pad = '  '.repeat(indent);
  const inner = entries.map((e) => stringifyEntry(e, indent + 1)).join(',\n');
  return `[\n${inner},\n${pad}]`;
}

function stringifyEntry(entry: ManifestEntry, indent: number): string {
  const pad = '  '.repeat(indent);
  const parts: string[] = [`id: '${entry.id}'`];
  if (entry.activatable) parts.push('activatable: true');
  if (entry.children?.length) parts.push(`children: ${stringifyEntries(entry.children, indent)}`);
  // Single-line short form when no children, multi-line otherwise.
  if (!entry.children?.length) return `${pad}{ ${parts.join(', ')} }`;
  const inner = parts.map((p) => `${pad}  ${p}`).join(',\n');
  return `${pad}{\n${inner},\n${pad}}`;
}

async function loadBasePaths(): Promise<Map<string, { activatable: boolean; source: 'virtual' | 'pending' }>> {
  const basePath = resolve(repoRoot, BASE_FILE);
  if (!existsSync(basePath)) return new Map();
  const mod = await import(pathToFileURL(basePath).href);
  const collect = new Map<string, { activatable: boolean; source: 'virtual' | 'pending' }>();
  function walkVirtual(entries: ManifestEntry[], parent: string): void {
    for (const e of entries) {
      const p = parent ? `${parent}/${e.id}` : e.id;
      collect.set(p, { activatable: !!e.activatable, source: 'virtual' });
      if (e.children) walkVirtual(e.children, p);
    }
  }
  if (Array.isArray(mod.VIRTUAL_HINTS)) walkVirtual(mod.VIRTUAL_HINTS as ManifestEntry[], '');
  if (Array.isArray(mod.PENDING_DIRECTIVES)) {
    for (const pd of mod.PENDING_DIRECTIVES as { path: string; activatable?: boolean }[]) {
      collect.set(pd.path, { activatable: !!pd.activatable, source: 'pending' });
    }
  }
  return collect;
}

async function checkI18nKeys(paths: string[]): Promise<void> {
  const enDict = await loadDict(EN_DICT, 'en');
  const zhDict = await loadDict(ZHTW_DICT, 'zhTW');
  for (const path of paths) {
    const segs = ['agentHint', ...path.split('/')];
    for (const [lang, dict] of [['en', enDict], ['zh-tw', zhDict]] as const) {
      const node = walkDict(dict, segs);
      if (!node || typeof node !== 'object') {
        warn(`[i18n] ${lang} missing entry: agentHint.${path.replace(/\//g, '.')}`);
        continue;
      }
      const entry = (node as Record<string, unknown>).self ?? node;
      const e = entry as Record<string, unknown>;
      if (typeof e.name !== 'string') warn(`[i18n] ${lang} missing .name at agentHint.${path.replace(/\//g, '.')}`);
      if (typeof e.description !== 'string') warn(`[i18n] ${lang} missing .description at agentHint.${path.replace(/\//g, '.')}`);
    }
  }
}

async function loadDict(relPath: string, exportName: string): Promise<Record<string, unknown> | null> {
  const full = resolve(repoRoot, relPath);
  if (!existsSync(full)) {
    warn(`[i18n] dictionary not found: ${relPath} — skipping check`);
    return null;
  }
  const mod = await import(pathToFileURL(full).href);
  return (mod[exportName] as Record<string, unknown>) ?? null;
}

function walkDict(dict: Record<string, unknown> | null, segs: string[]): unknown {
  if (!dict) return null;
  let cursor: unknown = dict;
  for (const seg of segs) {
    if (!cursor || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
