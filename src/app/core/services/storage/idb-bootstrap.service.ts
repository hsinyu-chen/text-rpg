import { Injectable } from '@angular/core';
import { openDB, DBSchema, IDBPDatabase, StoreNames } from 'idb';
import { StorageValue, Book, Collection } from '../../models/types';
import { PromptProfile } from '../../constants/prompt-profiles';

/** IDB-persisted user profile metadata. Built-in profiles never appear here. */
export type StoredProfileMeta = Required<Pick<PromptProfile, 'id' | 'displayName' | 'baseProfileId' | 'createdAt' | 'updatedAt'>>;

export interface TextRPGDB extends DBSchema {
    chat_store: {
        key: string;
        value: StorageValue;
    };
    file_store: {
        key: string;
        value: { name: string; content: string; lastModified: number; tokens?: number };
    };
    prompt_store: {
        key: string;
        value: { content: string; lastModified: number; tokens?: number };
    };
    prompt_profile_meta: {
        key: string;
        value: StoredProfileMeta;
    };
    books_store: {
        key: string;
        value: Book;
    };
    collections_store: {
        key: string;
        value: Collection;
    };
    // FileSystemDirectoryHandle persists across reloads via structured clone in IDB.
    // Permission state does NOT persist — see FileBackendPermissionService.
    sync_handles: {
        key: string;
        value: FileSystemDirectoryHandle;
    };
}

/**
 * Owns the single IDB connection. Repositories inject this and use
 * {@link IdbBootstrap.db} as their handle. The schema definition + upgrade
 * callback live here because they're the connection's contract — the per-
 * domain repositories don't need to know about each other's stores.
 */
@Injectable({ providedIn: 'root' })
export class IdbBootstrap {
    readonly db: Promise<IDBPDatabase<TextRPGDB>>;

    constructor() {
        this.db = openDB<TextRPGDB>('TextRPG_DB', 9, {
            upgrade(db, oldVersion) {
                if (oldVersion < 1) {
                    db.createObjectStore('chat_store');
                }
                if (oldVersion < 2) {
                    db.createObjectStore('file_store');
                }
                if (oldVersion < 4) {
                    // Cast to a temporary type containing the legacy store for deletion
                    const legacyDb = db as unknown as IDBPDatabase<TextRPGDB & { saves_store: { key: string; value: unknown } }>;
                    if (legacyDb.objectStoreNames.contains('saves_store')) {
                        legacyDb.deleteObjectStore('saves_store');
                    }
                }
                if (oldVersion < 5) {
                    if (!db.objectStoreNames.contains('prompt_store')) {
                        db.createObjectStore('prompt_store');
                    }
                }
                if (oldVersion < 6) {
                    if (!db.objectStoreNames.contains('books_store')) {
                        db.createObjectStore('books_store');
                    }
                }
                if (oldVersion < 7) {
                    if (!db.objectStoreNames.contains('collections_store')) {
                        db.createObjectStore('collections_store');
                    }
                }
                if (oldVersion < 8) {
                    if (!db.objectStoreNames.contains('sync_handles')) {
                        db.createObjectStore('sync_handles');
                    }
                }
                if (oldVersion < 9) {
                    if (!db.objectStoreNames.contains('prompt_profile_meta')) {
                        db.createObjectStore('prompt_profile_meta');
                    }
                }
            },
        });
    }
}

/**
 * Generic per-store CRUD helper. Each repository constructs one against the
 * IdbBootstrap handle for its own object store; the type parameters carry the
 * per-store key/value contract through to callsites without each repository
 * re-implementing the await-await dance.
 *
 * Not @Injectable — instantiated with `new IdbStore(bootstrap.db, 'name')`
 * in repository field initializers.
 */
type StoreName = StoreNames<TextRPGDB>;

/**
 * Per-store CRUD helper. Keys across all our stores are strings, so K is fixed
 * here — and that's what lets the generic compile against idb's per-store
 * signature union without per-callsite casts. V is the row shape; each
 * repository hard-codes it when constructing its IdbStore.
 */
export class IdbStore<V> {
    constructor(
        private readonly dbPromise: Promise<IDBPDatabase<TextRPGDB>>,
        private readonly storeName: StoreName,
    ) {}

    async get(key: string): Promise<V | undefined> {
        const db = await this.dbPromise;
        return db.get(this.storeName, key) as Promise<V | undefined>;
    }

    async put(key: string, value: V): Promise<void> {
        const db = await this.dbPromise;
        // idb's put signature varies per store; the runtime call works for
        // every store in our schema, but the union type can't prove it.
        await (db.put as (s: StoreName, v: unknown, k: string) => Promise<IDBValidKey>)(this.storeName, value, key);
    }

    async delete(key: string): Promise<void> {
        const db = await this.dbPromise;
        await db.delete(this.storeName, key);
    }

    async clear(): Promise<void> {
        const db = await this.dbPromise;
        await db.clear(this.storeName);
    }

    async getAll(): Promise<V[]> {
        const db = await this.dbPromise;
        return db.getAll(this.storeName) as Promise<V[]>;
    }
}
