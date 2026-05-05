import { KVStore } from '../services/kv/kv-store';

/**
 * In-memory {@link KVStore} for specs. Bind via:
 *
 * ```ts
 * const kv = new InMemoryKVStore({ app_exchange_rate: '32' });
 * TestBed.configureTestingModule({
 *     providers: [{ provide: KVStore, useValue: kv }],
 * });
 * ```
 */
export class InMemoryKVStore extends KVStore {
    private map = new Map<string, string>();

    constructor(seed?: Record<string, string>) {
        super();
        if (seed) for (const [k, v] of Object.entries(seed)) this.map.set(k, v);
    }

    get(key: string): string | null {
        return this.map.has(key) ? this.map.get(key)! : null;
    }

    set(key: string, value: string): void {
        this.map.set(key, value);
    }

    remove(key: string): void {
        this.map.delete(key);
    }

    /** Test helper — bulk set without going through `set()` per key. */
    seed(entries: Record<string, string>): void {
        for (const [k, v] of Object.entries(entries)) this.map.set(k, v);
    }

    /** Test helper — read everything (e.g. to assert what got persisted). */
    snapshot(): Record<string, string> {
        return Object.fromEntries(this.map);
    }
}
