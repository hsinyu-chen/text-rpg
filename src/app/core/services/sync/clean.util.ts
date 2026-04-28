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
    const b = (input && typeof input === 'object' ? input : {}) as Partial<Book> & Record<string, unknown>;
    const stats = (b.stats && typeof b.stats === 'object' ? b.stats : {}) as Partial<Book['stats']>;
    return {
        id: String(b.id ?? ''),
        name: String(b.name ?? ''),
        collectionId: String(b.collectionId ?? 'root'),
        // 0 fallback (not Date.now()) — legacy rows lacking the field
        // shouldn't masquerade as "freshly edited now" and clobber a
        // newer cloud copy under newer-wins. Code paths that genuinely
        // create new entities stamp the real timestamp themselves.
        createdAt: Number(b.createdAt) || 0,
        lastActiveAt: Number(b.lastActiveAt) || 0,
        preview: String(b.preview ?? ''),
        messages: Array.isArray(b.messages) ? b.messages : [],
        files: Array.isArray(b.files) ? b.files : [],
        stats: {
            tokenUsage: { freshInput: 0, cached: 0, output: 0, total: 0, ...stats.tokenUsage },
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
    const c = (input && typeof input === 'object' ? input : {}) as Partial<Collection> & Record<string, unknown>;
    return {
        id: String(c.id ?? ''),
        name: String(c.name ?? ''),
        // 0 fallback for the same reason as cleanBookForSync — see comment there.
        createdAt: Number(c.createdAt) || 0,
        updatedAt: Number(c.updatedAt) || 0
    };
}
