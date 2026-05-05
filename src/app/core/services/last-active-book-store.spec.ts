import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LastActiveBookStore } from './last-active-book-store';
import { KVStore } from './kv/kv-store';
import { InMemoryKVStore } from '../testing/in-memory-kv-store';

function setup(seed: Record<string, string> = {}): { store: LastActiveBookStore; kv: InMemoryKVStore } {
    const kv = new InMemoryKVStore(seed);
    TestBed.configureTestingModule({
        providers: [{ provide: KVStore, useValue: kv }],
    });
    return { store: TestBed.inject(LastActiveBookStore), kv };
}

describe('LastActiveBookStore', () => {
    it('starts as null when nothing is persisted', () => {
        const { store } = setup();
        expect(store.id()).toBeNull();
    });

    it('loads the persisted book id on construction', () => {
        const { store } = setup({ last_active_book_id: 'book-abc' });
        expect(store.id()).toBe('book-abc');
    });

    it('set(id) writes to KV; set(null) removes the key', () => {
        const { store, kv } = setup();
        store.set('book-1');
        expect(store.id()).toBe('book-1');
        expect(kv.get('last_active_book_id')).toBe('book-1');

        store.set(null);
        expect(store.id()).toBeNull();
        expect(kv.get('last_active_book_id')).toBeNull();
    });
});
