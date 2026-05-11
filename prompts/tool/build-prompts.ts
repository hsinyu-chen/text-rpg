import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import chokidar from 'chokidar';

import { runCheck } from './check';
import { REPO_ROOT, runPipeline } from './pipeline';
import { Diagnostic } from './types';

const MANIFEST_PATH = resolve(REPO_ROOT, 'prompts/tool/.manifest.json');
const SOURCE_DIR = resolve(REPO_ROOT, 'prompts/source');
const CONFIG_FILE = resolve(REPO_ROOT, 'prompts/tool/variants.config.ts');
const WATCH_DEBOUNCE_MS = 100;

function logDiagnostic(d: Diagnostic): void {
  const tag = d.level === 'error' ? '[error]' : '[warning]';
  const loc = d.line ? `${d.file}:${d.line}` : d.file;
  process.stderr.write(`${tag} ${loc}: ${d.message}\n`);
}

function summarize(diagnostics: ReadonlyArray<Diagnostic>): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.level === 'error') errors++;
    else if (d.level === 'warning') warnings++;
  }
  return { errors, warnings };
}

interface RunResult {
  errors: number;
  warnings: number;
  earlyErrors: number;
}

function runOnce(checkMode: boolean): RunResult {
  const output = runPipeline();
  const diagnostics: Diagnostic[] = [...output.diagnostics];
  const earlyErrors = summarize(diagnostics).errors;

  if (checkMode && earlyErrors === 0) {
    diagnostics.push(...runCheck(output, { manifestPath: MANIFEST_PATH }));
  } else if (!checkMode && earlyErrors === 0) {
    for (const [path, content] of output.files) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, { encoding: 'utf8' });
    }
    writeFileSync(
      MANIFEST_PATH,
      JSON.stringify(output.manifest, null, 2) + '\n',
      { encoding: 'utf8' },
    );
  }

  for (const d of diagnostics) logDiagnostic(d);
  const { errors, warnings } = summarize(diagnostics);

  if (errors > 0 || warnings > 0) {
    process.stderr.write(`\n${errors} error(s), ${warnings} warning(s)\n`);
    if (!checkMode && earlyErrors > 0) {
      process.stderr.write('Build aborted before writing output (parser/composer errors).\n');
    }
  } else {
    process.stderr.write(checkMode ? 'prompts:check OK\n' : 'prompts:build OK\n');
  }

  return { errors, warnings, earlyErrors };
}

function startWatch(): void {
  process.stderr.write(`prompts:watch — watching ${SOURCE_DIR}\n`);

  let pending: NodeJS.Timeout | null = null;
  let running = false;
  let queued = false;

  const triggerBuild = (): void => {
    if (running) { queued = true; return; }
    running = true;
    try {
      runOnce(false);
    } catch (e) {
      process.stderr.write(`watch: build threw: ${(e as Error).message}\n`);
    } finally {
      running = false;
      if (queued) { queued = false; setImmediate(triggerBuild); }
    }
  };

  const schedule = (): void => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = null; triggerBuild(); }, WATCH_DEBOUNCE_MS);
  };

  const watcher = chokidar.watch([SOURCE_DIR, CONFIG_FILE], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
  });
  watcher.on('add', schedule);
  watcher.on('change', schedule);
  watcher.on('unlink', schedule);
  watcher.on('error', (err) => {
    process.stderr.write(`watch error: ${(err as Error).message}\n`);
  });

  const close = (): void => {
    void watcher.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');
  const watchMode = args.includes('--watch');

  if (watchMode && checkMode) {
    process.stderr.write('--watch and --check are mutually exclusive\n');
    process.exit(2);
  }

  const result = runOnce(checkMode);

  if (watchMode) {
    startWatch();
    return;
  }

  const failed = result.errors > 0 || (checkMode && result.warnings > 0);
  process.exit(failed ? 1 : 0);
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n${(e as Error).stack ?? ''}\n`);
  process.exit(1);
});
