/**
 * Build-time generator for agent-hints.manifest.generated.ts.
 *
 * Scans src/**\/*.component.html for `appAgentHint="path"` attributes (+
 * `(hintActivate)` events), then writes a flat `AgentHintPathDecl[]`
 * the runtime registry merges with manifest.base.ts and reshapes into
 * the final tree.
 *
 * All checks emit WARNINGS to stderr — never exits non-zero on findings.
 * Exits non-zero only on hard runtime failures (parser crash, IO error).
 *
 * Run: npm run hints:build
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
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

interface PathDecl {
  path: string;
  activatable?: boolean;
}

const repoRoot = process.cwd();
const SRC_ROOT = 'src';
const TEMPLATE_SUFFIX = '.component.html';
const OUTPUT = 'src/app/core/services/agent-hints/agent-hints.manifest.generated.ts';
const BASE_FILE = 'src/app/core/services/agent-hints/agent-hints.manifest.base.ts';
const EN_DICT = 'src/app/core/i18n/dictionaries/en.ts';
const ZHTW_DICT = 'src/app/core/i18n/dictionaries/zh-tw.ts';

const warnings: string[] = [];
function warn(message: string): void {
  warnings.push(message);
}

async function main(): Promise<void> {
  const files = readdirSync(resolve(repoRoot, SRC_ROOT), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(TEMPLATE_SUFFIX))
    .map((d) => resolve(d.parentPath, d.name));
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
  const astPaths = new Map<string, boolean>();
  for (const b of bindings) {
    if (b.isDynamic) {
      warn(`[dynamic-path] ${relative(repoRoot, b.file)}:${b.line}:${b.col} — [appAgentHint] is bound, registry cannot statically register "${b.path}"`);
      continue;
    }
    const prev = astPaths.get(b.path);
    astPaths.set(b.path, b.activatable || (prev ?? false));
  }

  // i18n check needs the auto-filled intermediates too.
  const pathsForI18nCheck = new Set(astPaths.keys());
  for (const path of [...astPaths.keys()]) {
    const segs = path.split('/');
    for (let i = 1; i < segs.length; i++) pathsForI18nCheck.add(segs.slice(0, i).join('/'));
  }

  // Conflict check vs base. Only warn when activatable disagrees — pure
  // structural overlap (a base subtree happening to declare a container
  // path the AST also discovered) is benign.
  const basePaths = await loadBasePaths();
  for (const [path, baseActivatable] of basePaths) {
    const astActivatable = astPaths.get(path);
    if (astActivatable !== undefined && astActivatable !== baseActivatable) {
      warn(`[conflict] ${path} — base says activatable=${baseActivatable}, AST says ${astActivatable}`);
    }
  }

  await checkI18nKeys([...pathsForI18nCheck, ...basePaths.keys()]);

  const decls: PathDecl[] = [...astPaths.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([path, activatable]) => (activatable ? { path, activatable: true } : { path }));

  writeFileSync(resolve(repoRoot, OUTPUT), renderGenerated(decls), 'utf8');
  console.log(`Wrote ${OUTPUT} (${decls.length} paths from ${files.length} templates)`);

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
      empty?: { children?: unknown[] };
      placeholder?: { children?: unknown[] };
      loading?: { children?: unknown[] };
      error?: { children?: unknown[] };
    };

    const staticHint = node.attributes?.find((a) => a.name === 'appAgentHint');
    const boundHint = node.inputs?.find((i) => i.name === 'appAgentHint');
    const hintActivate = node.outputs?.find((o) => o.name === 'hintActivate');

    if (staticHint || boundHint || hintActivate) {
      const path = staticHint?.value ?? boundHint?.value?.source ?? '';
      const span = node.startSourceSpan?.start;
      const loc = `${relative(repoRoot, file)}:${(span?.line ?? 0) + 1}:${(span?.col ?? 0) + 1}`;
      if (!path && hintActivate) {
        warn(`[orphan-activate] ${loc} — (hintActivate) without an appAgentHint path`);
      } else if (path) {
        out.push({
          path,
          activatable: !!hintActivate,
          file,
          line: (span?.line ?? 0) + 1,
          col: (span?.col ?? 0) + 1,
          isDynamic: !!boundHint && !staticHint,
        });
      }
    }

    if (node.children?.length) walk(node.children, file, out);
    if (node.branches) for (const b of node.branches) if (b.children?.length) walk(b.children, file, out);
    if (node.cases) for (const c of node.cases) if (c.children?.length) walk(c.children, file, out);
    if (node.body?.length) walk(node.body, file, out);
    // Angular 17+ secondary blocks: @for's @empty, @defer's @placeholder/@loading/@error.
    if (node.empty?.children?.length) walk(node.empty.children, file, out);
    if (node.placeholder?.children?.length) walk(node.placeholder.children, file, out);
    if (node.loading?.children?.length) walk(node.loading.children, file, out);
    if (node.error?.children?.length) walk(node.error.children, file, out);
  }
}

function renderGenerated(decls: PathDecl[]): string {
  const banner = `// AUTO-GENERATED by tools/build-hints.ts — DO NOT EDIT.\n// Run \`npm run hints:build\` to regenerate after touching templates.\n`;
  const body = `import type { AgentHintPathDecl } from './agent-hints.types';\n\nexport const GENERATED_HINTS: AgentHintPathDecl[] = [\n${decls
    .map((d) => (d.activatable
      ? `  { path: ${JSON.stringify(d.path)}, activatable: true },`
      : `  { path: ${JSON.stringify(d.path)} },`))
    .join('\n')}\n];\n`;
  return banner + '\n' + body;
}

async function loadBasePaths(): Promise<Map<string, boolean>> {
  const basePath = resolve(repoRoot, BASE_FILE);
  if (!existsSync(basePath)) return new Map();
  const mod = await import(pathToFileURL(basePath).href);
  const collect = new Map<string, boolean>();
  function walkVirtual(entries: ManifestEntry[], parent: string): void {
    for (const e of entries) {
      const p = parent ? `${parent}/${e.id}` : e.id;
      collect.set(p, !!e.activatable);
      if (e.children) walkVirtual(e.children, p);
    }
  }
  if (Array.isArray(mod.VIRTUAL_HINTS)) walkVirtual(mod.VIRTUAL_HINTS as ManifestEntry[], '');
  if (Array.isArray(mod.PENDING_DIRECTIVES)) {
    for (const pd of mod.PENDING_DIRECTIVES as PathDecl[]) {
      collect.set(pd.path, !!pd.activatable);
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
