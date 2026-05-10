import { existsSync, readFileSync } from 'node:fs';

import { manifestEntriesEqual, PipelineOutput } from './pipeline';
import { Diagnostic, Manifest } from './types';

export interface CheckOptions {
  manifestPath: string;
}

export function runCheck(
  output: Pick<PipelineOutput, 'files' | 'manifest'>,
  opts: CheckOptions,
): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const [filePath, expected] of output.files) {
    if (!existsSync(filePath)) {
      out.push({
        level: 'error', file: filePath,
        message: 'generated file missing on disk (run `npm run prompts:build`)',
      });
      continue;
    }
    const onDisk = readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    if (onDisk !== expected) {
      out.push({
        level: 'error', file: filePath,
        message: 'on-disk content differs from build output (source changed without rebuild)',
      });
    }
  }

  if (existsSync(opts.manifestPath)) {
    try {
      const onDisk = JSON.parse(readFileSync(opts.manifestPath, 'utf8')) as Manifest;
      if (!manifestEntriesEqual(onDisk, output.manifest)) {
        out.push({
          level: 'error', file: opts.manifestPath,
          message: 'manifest entries differ from build output (run `npm run prompts:build` and commit)',
        });
      }
    } catch (e) {
      out.push({
        level: 'error', file: opts.manifestPath,
        message: `manifest parse error: ${(e as Error).message}`,
      });
    }
  } else {
    out.push({
      level: 'error', file: opts.manifestPath,
      message: 'manifest missing (run `npm run prompts:build` and commit)',
    });
  }

  return out;
}
