/**
 * Loads `.env.test.local` (gitignored) into `process.env` if present.
 *
 * Integration specs (`*.integration.spec.ts`) gate themselves via
 * `describe.skipIf(!process.env.S3_TEST_BUCKET)(...)`, so this loader is a
 * no-op on machines without the local creds file (CI / fresh checkouts):
 * the integration specs simply skip.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(__dirname, '..', '.env.test.local');
if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        const [, key, rawValue] = m;
        if (process.env[key] !== undefined) continue;
        // Trim trailing whitespace then strip surrounding quotes if present.
        let value = rawValue.replace(/\s+$/, '');
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[key] = value;
    }
}
