import { spawn } from 'node:child_process';

import { runOnce, startWatch } from '../prompts/tool/build-prompts';

const ngArgs = process.argv.slice(2);

const initial = runOnce(false);
if (initial.errors > 0) {
  process.stderr.write('prompts:build failed — aborting dev start.\n');
  process.exit(1);
}

const closeWatcher = startWatch();

const child = spawn('ng', ['serve', ...ngArgs], {
  stdio: 'inherit',
  shell: true,
});

let shuttingDown = false;
const shutdown = (code: number): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (child.exitCode === null && !child.killed) child.kill();
  } catch { /* child already gone */ }
  void closeWatcher().finally(() => process.exit(code));
};

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));
child.on('exit', (code, signal) => {
  const exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 0);
  shutdown(exitCode);
});
