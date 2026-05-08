import { BlobStore } from '../blob-store';
import { PROMPTS_KEY } from '../layout/sync-paths';

/**
 * Single-file persistence for the synced prompts document. See
 * {@link SettingsRepository} for the null-on-missing rationale.
 */
export class PromptsRepository {
    constructor(private readonly blob: BlobStore) {}

    async read(): Promise<string | null> {
        if (!await this.blob.exists(PROMPTS_KEY)) return null;
        const result = await this.blob.read(PROMPTS_KEY);
        return result.text;
    }

    write(content: string): Promise<void> {
        return this.blob.write(PROMPTS_KEY, content);
    }
}
