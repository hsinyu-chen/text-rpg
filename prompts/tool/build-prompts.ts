import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { runCheck } from './check';
import { REPO_ROOT, runPipeline } from './pipeline';
import { Diagnostic } from './types';

const MANIFEST_PATH = resolve(REPO_ROOT, 'prompts/tool/.manifest.json');

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');

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

  process.exit(errors === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n${(e as Error).stack ?? ''}\n`);
  process.exit(1);
});
