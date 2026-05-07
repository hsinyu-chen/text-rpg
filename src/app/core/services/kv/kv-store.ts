/**
 * Abstract synchronous key/value store. The only abstraction in the
 * config-storage stack that exists *because of testing* — production
 * code uses {@link LocalStorageKVStore}, specs swap in
 * {@link InMemoryKVStore} via TestBed providers without needing jsdom
 * or a localStorage mock.
 *
 * Kept synchronous on purpose: the existing call sites all read on
 * service construction and the underlying `localStorage` is sync.
 * IndexedDB-backed config is out of scope.
 */
export abstract class KVStore {
    abstract get(key: string): string | null;
    abstract set(key: string, value: string): void;
    abstract remove(key: string): void;

    /**
     * Snapshot of all currently-stored keys. Required for the rare cases
     * (settings export/import, one-shot legacy purges) that need to iterate
     * over the entire store instead of accessing keys by name. Returning a
     * fresh array on every call lets callers mutate during iteration.
     */
    abstract keys(): string[];
}
