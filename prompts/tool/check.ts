import { existsSync, readFileSync } from 'node:fs';

import { manifestEntriesEqual, PipelineOutput } from './pipeline';
import { Diagnostic, Manifest } from './types';

export interface CheckOptions {
  manifestPath: string;
}

export function runCheck(
  output: Pick<PipelineOutput, 'manifest'>,
  opts: CheckOptions,
): Diagnostic[] {
  const out: Diagnostic[] = [];

  if (!existsSync(opts.manifestPath)) {
    out.push({
      level: 'error', file: opts.manifestPath,
      message: 'manifest missing (run `npm run prompts:build` and commit the manifest)',
    });
    return out;
  }

  try {
    const onDisk = JSON.parse(readFileSync(opts.manifestPath, 'utf8')) as Manifest;
    if (!manifestEntriesEqual(onDisk, output.manifest)) {
      out.push({
        level: 'error', file: opts.manifestPath,
        message: 'manifest entries differ from build output (run `npm run prompts:build` and commit the manifest)',
      });
    }
  } catch (e) {
    out.push({
      level: 'error', file: opts.manifestPath,
      message: `manifest parse error: ${(e as Error).message}`,
    });
  }

  return out;
}
