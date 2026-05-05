import { Injectable, inject, signal } from '@angular/core';
import { KVStore } from './kv/kv-store';

const KEY = 'last_active_book_id';

/**
 * Persists which book the user had open last so the next session can
 * resume there. Conceptually session state, not user preference — kept
 * separate from {@link AppConfigStore} so the two have different test
 * setups and different lifecycles.
 */
@Injectable({ providedIn: 'root' })
export class LastActiveBookStore {
    private kv = inject(KVStore);

    readonly id = signal<string | null>(null);

    constructor() {
        this.id.set(this.kv.get(KEY));
    }

    set(bookId: string | null): void {
        this.id.set(bookId);
        if (bookId) this.kv.set(KEY, bookId);
        else this.kv.remove(KEY);
    }
}
