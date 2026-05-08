import { BlobStore } from '../blob-store';
import { SETTINGS_KEY } from '../layout/sync-paths';

/**
 * Single-file persistence for the synced settings document. Returns null
 * when the file doesn't exist yet (fresh device / never written) so the
 * caller can distinguish "no settings on cloud" from "empty settings".
 */
export class SettingsRepository {
    constructor(private readonly blob: BlobStore) {}

    async read(): Promise<string | null> {
        if (!await this.blob.exists(SETTINGS_KEY)) return null;
        const result = await this.blob.read(SETTINGS_KEY);
        return result.text;
    }

    write(content: string): Promise<void> {
        return this.blob.write(SETTINGS_KEY, content);
    }
}
