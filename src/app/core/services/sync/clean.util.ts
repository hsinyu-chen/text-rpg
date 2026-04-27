import { Book, Collection } from '../../models/types';

/**
 * Returns a fresh Book containing only the fields the current schema
 * recognizes. Strips legacy / forward-compatible fields that may linger in
 * IDB or in a downloaded payload (e.g. `prompts` from before that was moved
 * out of the Book schema).
 *
 * The returned object is what gets persisted to IDB and uploaded to cloud.
 * Defense-in-depth: callers can pass an `unknown` shape and still get a
 * typed Book back.
 */
export function cleanBookForSync(input: unknown): Book {
    const b = input as Partial<Book> & Record<string, unknown>;
    const stats = (b.stats ?? {}) as Partial<Book['stats']>;
    return {
        id: String(b.id ?? ''),
        name: String(b.name ?? ''),
        collectionId: String(b.collectionId ?? 'root'),
        createdAt: Number(b.createdAt) || Date.now(),
        lastActiveAt: Number(b.lastActiveAt) || Date.now(),
        preview: String(b.preview ?? ''),
        messages: Array.isArray(b.messages) ? b.messages : [],
        files: Array.isArray(b.files) ? b.files : [],
        stats: {
            tokenUsage: stats.tokenUsage ?? { freshInput: 0, cached: 0, output: 0, total: 0 },
            estimatedCost: Number(stats.estimatedCost) || 0,
            historyStorageUsage: Number(stats.historyStorageUsage) || 0,
            sunkUsageHistory: Array.isArray(stats.sunkUsageHistory) ? stats.sunkUsageHistory : [],
            kbCacheName: stats.kbCacheName ?? null,
            kbCacheExpireTime: stats.kbCacheExpireTime ?? null,
            kbCacheTokens: Number(stats.kbCacheTokens) || 0,
            estimatedKbTokens: Number(stats.estimatedKbTokens) || 0,
            kbCacheHash: stats.kbCacheHash ?? null,
            kbStorageUsageAcc: Number(stats.kbStorageUsageAcc) || 0
        }
    };
}

export function cleanCollectionForSync(input: unknown): Collection {
    const c = input as Partial<Collection> & Record<string, unknown>;
    return {
        id: String(c.id ?? ''),
        name: String(c.name ?? ''),
        createdAt: Number(c.createdAt) || Date.now(),
        updatedAt: Number(c.updatedAt) || Date.now()
    };
}
