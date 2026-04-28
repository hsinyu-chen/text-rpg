import { Injectable } from '@angular/core';
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { StorageValue, SessionSave, ChatMessage, Book, Collection } from '../models/types';
import { cleanBookForSync, cleanCollectionForSync } from './sync/clean.util';
import { PromptProfile } from '../constants/prompt-profiles';

/** IDB-persisted user profile metadata. Built-in profiles never appear here. */
export type StoredProfileMeta = Required<Pick<PromptProfile, 'id' | 'displayName' | 'baseProfileId' | 'createdAt' | 'updatedAt'>>;

interface TextRPGDB extends DBSchema {
  chat_store: {
    key: string;
    value: StorageValue;
  };
  file_store: {
    key: string;
    value: { name: string, content: string, lastModified: number, tokens?: number };
  };
  prompt_store: {
    key: string;
    value: { content: string, lastModified: number, tokens?: number };
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

@Injectable({
  providedIn: 'root'
})
export class StorageService {
  private dbPromise: Promise<IDBPDatabase<TextRPGDB>>;

  constructor() {
    this.dbPromise = openDB<TextRPGDB>('TextRPG_DB', 9, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('chat_store');
        }
        if (oldVersion < 2) {
          db.createObjectStore('file_store');
        }
        if (oldVersion < 4) {
          // Cast to a temporary type containing the legacy store for deletion
          const legacyDb = db as unknown as IDBPDatabase<TextRPGDB & { saves_store: { key: string, value: unknown } }>;
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

  /**
   * Retrieves a value from the IndexedDB chat store.
   * @param key The storage key.
   * @returns The stored value or undefined if not found.
   */
  async get<T extends StorageValue>(key: string): Promise<T | undefined> {
    return (await this.dbPromise).get('chat_store', key) as Promise<T | undefined>;
  }

  /**
   * Saves or updates a value in the IndexedDB chat store.
   * @param key The storage key.
   * @param val The value to store.
   */
  async set(key: string, val: StorageValue): Promise<void> {
    (await this.dbPromise).put('chat_store', val, key);
  }

  /**
   * Deletes a value from the IndexedDB chat store.
   * @param key The storage key.
   */
  async delete(key: string): Promise<void> {
    (await this.dbPromise).delete('chat_store', key);
  }

  /**
   * Clears all data from the IndexedDB chat store.
   */
  async clear(): Promise<void> {
    (await this.dbPromise).clear('chat_store');
  }

  /**
   * Retrieves a file from the file_store.
   */
  async getFile(name: string) {
    return (await this.dbPromise).get('file_store', name);
  }

  /**
   * Saves a file to the file_store.
   */
  async saveFile(name: string, content: string, tokens?: number) {
    await (await this.dbPromise).put('file_store', { name, content, tokens, lastModified: Date.now() }, name);
  }

  /**
   * Retrieves all files from the file_store.
   */
  async getAllFiles() {
    return (await this.dbPromise).getAll('file_store');
  }

  /**
   * Clears all files from the file_store.
   */
  async clearFiles() {
    await (await this.dbPromise).clear('file_store');
  }

  /**
   * Deletes a specific file from the file_store.
   */
  async deleteFile(name: string) {
    await (await this.dbPromise).delete('file_store', name);
  }

  // ========== Prompt Store (v5+) ==========

  /**
   * Retrieves a prompt from the prompt_store.
   */
  async getPrompt(name: string) {
    return (await this.dbPromise).get('prompt_store', name);
  }

  /**
   * Saves a prompt to the prompt_store.
   */
  async savePrompt(name: string, content: string, tokens?: number) {
    await (await this.dbPromise).put('prompt_store', { content, tokens, lastModified: Date.now() }, name);
  }

  /**
   * Clears all prompts from the prompt_store.
   */
  async clearPrompts() {
    await (await this.dbPromise).clear('prompt_store');
  }

  /**
   * Gets a profile-scoped prompt key.
   * Default profile ('cloud') uses the bare key for backward compatibility.
   */
  private getProfilePromptKey(name: string, profileId: string): string {
    return profileId === 'cloud' ? name : `${profileId}:${name}`;
  }

  /**
   * Retrieves a prompt scoped to a specific profile.
   */
  async getProfilePrompt(name: string, profileId: string) {
    return (await this.dbPromise).get('prompt_store', this.getProfilePromptKey(name, profileId));
  }

  /**
   * Saves a prompt scoped to a specific profile.
   */
  async saveProfilePrompt(name: string, profileId: string, content: string, tokens?: number) {
    const key = this.getProfilePromptKey(name, profileId);
    await (await this.dbPromise).put('prompt_store', { content, tokens, lastModified: Date.now() }, key);
  }

  /**
   * Deletes every prompt row scoped to the given profile (`profileId:*`).
   * No-op for the default profile to avoid wiping the unprefixed cloud rows.
   */
  async deleteAllProfilePrompts(profileId: string): Promise<void> {
    if (profileId === 'cloud') return;
    const db = await this.dbPromise;
    const tx = db.transaction('prompt_store', 'readwrite');
    const prefix = `${profileId}:`;
    let cursor = await tx.store.openCursor();
    while (cursor) {
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
        await cursor.delete();
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  // ========== Prompt Profile Meta (v9+) ==========

  async listProfileMeta(): Promise<StoredProfileMeta[]> {
    return (await this.dbPromise).getAll('prompt_profile_meta');
  }

  async getProfileMeta(id: string): Promise<StoredProfileMeta | undefined> {
    return (await this.dbPromise).get('prompt_profile_meta', id);
  }

  async putProfileMeta(meta: StoredProfileMeta): Promise<void> {
    await (await this.dbPromise).put('prompt_profile_meta', meta, meta.id);
  }

  async deleteProfileMeta(id: string): Promise<void> {
    await (await this.dbPromise).delete('prompt_profile_meta', id);
  }

  // ========== Books Store (v6+) ==========

  async getBooks(): Promise<Book[]> {
    return (await this.dbPromise).getAll('books_store');
  }

  async getBook(id: string): Promise<Book | undefined> {
    return (await this.dbPromise).get('books_store', id);
  }

  async saveBook(book: Book): Promise<void> {
    // Run every write through the cleaner so legacy / forward-compat fields
    // (e.g. removed `book.prompts`) never persist past this layer.
    const clean = cleanBookForSync(book);
    await (await this.dbPromise).put('books_store', clean, clean.id);
  }

  async deleteBook(id: string): Promise<void> {
    await (await this.dbPromise).delete('books_store', id);
  }

  // ========== Collections Store (v7+) ==========

  async getCollections(): Promise<Collection[]> {
    return (await this.dbPromise).getAll('collections_store');
  }

  async getCollection(id: string): Promise<Collection | undefined> {
    return (await this.dbPromise).get('collections_store', id);
  }

  async saveCollection(collection: Collection): Promise<void> {
    const clean = cleanCollectionForSync(collection);
    await (await this.dbPromise).put('collections_store', clean, clean.id);
  }

  async deleteCollection(id: string): Promise<void> {
    await (await this.dbPromise).delete('collections_store', id);
  }

  // ========== Sync Handles (v8+) ==========

  async getDirHandle(key: string): Promise<FileSystemDirectoryHandle | undefined> {
    return (await this.dbPromise).get('sync_handles', key);
  }

  async setDirHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
    await (await this.dbPromise).put('sync_handles', handle, key);
  }

  async clearDirHandle(key: string): Promise<void> {
    await (await this.dbPromise).delete('sync_handles', key);
  }

  // ========== Session Saves (REMOVED) ==========

  // ========== Data Migration Utilities ==========

  /**
   * Migrates a SessionSave from old flat format to new nested format if needed.
   * This should be called when loading saves from local storage or cloud.
   * @param save The session save to migrate.
   * @returns The migrated session save.
   */
  migrateSessionSave(save: SessionSave): SessionSave {
    // Note: The parts structure in ChatMessage hasn't changed.
    // Only the API response JSON structure changed from flat to nested.
    // Old saved messages already have content/analysis/summary extracted to ChatMessage fields,
    // so no migration is actually needed for saved data.
    // This method is here for future-proofing if we ever need to migrate saved data.
    return save;
  }

  /**
   * Migrates chat history array from old format if needed.
   * @param messages The chat messages array to migrate.
   * @returns The migrated chat messages array.
   */
  migrateChatHistory(messages: ChatMessage[]): ChatMessage[] {
    // Same as above - ChatMessage structure hasn't changed,
    // only the API response JSON format changed.
    // Content, analysis, summary are already fields in ChatMessage.
    return messages;
  }
}
