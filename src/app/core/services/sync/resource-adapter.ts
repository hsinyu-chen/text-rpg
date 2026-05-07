import { Injectable, inject } from '@angular/core';
import { Book, Collection } from '@app/core/models/types';
import { BookRepository } from '../storage/book.repository';
import { CollectionRepository } from '../storage/collection.repository';
import { SyncResource } from './sync.types';
import { cleanBookForSync, cleanCollectionForSync } from './clean.util';

export type SyncEntity = Book | Collection;

/**
 * Per-resource façade for the operations the reconciler / snapshot logic
 * needs without branching on `SyncResource`. Callers loop `for (const r of
 * resources)` and dispatch via `registry.get(r)`; adding a new SyncResource
 * means adding one entry to `adapters` and the rest of the system follows.
 *
 * Methods accept `SyncEntity` (the union) rather than a generic-typed entity
 * because the reconciler treats local rows uniformly — the adapter for a
 * given resource only sees rows of its own type at runtime, so the internal
 * implementations cast safely.
 */
export interface ResourceAdapter {
    list(): Promise<SyncEntity[]>;
    save(item: SyncEntity): Promise<void>;
    delete(id: string): Promise<void>;
    /** Strips fields that shouldn't sync (drafts, transient state). */
    clean(item: SyncEntity): SyncEntity;
    /** Parse JSON, clean, persist locally, return the persisted entity. */
    applyRemote(json: string): Promise<SyncEntity>;
    /** Device-clock activity time used by newer-wins decisions. 0 if missing. */
    timestampOf(item: SyncEntity): number;
}

@Injectable({ providedIn: 'root' })
export class ResourceAdapterRegistry {
    private books = inject(BookRepository);
    private collections = inject(CollectionRepository);

    private readonly adapters: Record<SyncResource, ResourceAdapter> = {
        book: this.makeBookAdapter(),
        collection: this.makeCollectionAdapter()
    };

    get(resource: SyncResource): ResourceAdapter {
        return this.adapters[resource];
    }

    private makeBookAdapter(): ResourceAdapter {
        return {
            list: () => this.books.list(),
            save: (b) => this.books.save(b as Book),
            delete: (id) => this.books.delete(id),
            clean: (b) => cleanBookForSync(b as Book),
            applyRemote: async (json) => {
                const book = cleanBookForSync(JSON.parse(json));
                await this.books.save(book);
                return book;
            },
            // Fallback to 0 for legacy IDB rows missing the timestamp field —
            // `undefined > N` returns false in both directions, so without this
            // a legacy entry would stall forever (never recognised as older or
            // newer than its remote counterpart).
            timestampOf: (b) => (b as Book).lastActiveAt || 0
        };
    }

    private makeCollectionAdapter(): ResourceAdapter {
        return {
            list: () => this.collections.list(),
            save: (c) => this.collections.save(c as Collection),
            delete: (id) => this.collections.delete(id),
            clean: (c) => cleanCollectionForSync(c as Collection),
            applyRemote: async (json) => {
                const collection = cleanCollectionForSync(JSON.parse(json));
                await this.collections.save(collection);
                return collection;
            },
            timestampOf: (c) => (c as Collection).updatedAt || 0
        };
    }
}

/**
 * Splits a flat list of resource-tagged items into per-resource buckets.
 * Adding a new SyncResource forces this object literal to grow — keeps
 * call sites exhaustively typed without each one re-implementing the
 * filter pair.
 */
export function groupByResource<T extends { resource: SyncResource }>(
    items: readonly T[]
): Record<SyncResource, T[]> {
    return {
        book: items.filter(t => t.resource === 'book'),
        collection: items.filter(t => t.resource === 'collection')
    };
}
