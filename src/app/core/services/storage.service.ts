import { Injectable } from '@angular/core';
import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { StorageValue, SessionSave, ChatMessage } from '../models/types';

interface TextRPGDB extends DBSchema {
  chat_store: {
    key: string;
    value: StorageValue;
  };
  file_store: {
    key: string;
    value: { name: string, content: string, lastModified: number, tokens?: number };
  };
}

@Injectable({
  providedIn: 'root'
})
export class StorageService {
  private dbPromise: Promise<IDBPDatabase<TextRPGDB>>;

  constructor() {
    this.dbPromise = openDB<TextRPGDB>('TextRPG_DB', 4, {
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
