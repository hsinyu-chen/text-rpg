import { Injectable, inject, signal } from '@angular/core';
import { StorageService } from './storage.service';
import { Collection, ROOT_COLLECTION_ID, Scenario } from '../models/types';

@Injectable({ providedIn: 'root' })
export class CollectionService {
    private storage = inject(StorageService);

    collections = signal<Collection[]>([]);

    async load(): Promise<void> {
        const list = await this.storage.getCollections();
        this.collections.set(list.sort((a, b) => a.createdAt - b.createdAt));
    }

    async ensureRoot(): Promise<Collection> {
        const existing = await this.storage.getCollection(ROOT_COLLECTION_ID);
        if (existing) return existing;
        const root: Collection = {
            id: ROOT_COLLECTION_ID,
            name: 'Root',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await this.storage.saveCollection(root);
        return root;
    }

    async create(name: string): Promise<Collection> {
        const c: Collection = {
            id: crypto.randomUUID(),
            name: name.trim() || 'Untitled',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await this.storage.saveCollection(c);
        await this.load();
        return c;
    }

    async rename(id: string, newName: string): Promise<void> {
        if (id === ROOT_COLLECTION_ID) {
            throw new Error('Root collection cannot be renamed.');
        }
        const c = await this.storage.getCollection(id);
        if (!c) return;
        c.name = newName.trim() || c.name;
        c.updatedAt = Date.now();
        await this.storage.saveCollection(c);
        await this.load();
    }

    /**
     * Deletes a collection. Throws if it's root or contains any books.
     * Use merge/move helpers (future) to relocate books before deletion.
     */
    async remove(id: string): Promise<void> {
        if (id === ROOT_COLLECTION_ID) {
            throw new Error('Root collection cannot be deleted.');
        }
        const books = await this.storage.getBooks();
        const occupied = books.some(b => b.collectionId === id);
        if (occupied) {
            throw new Error('Collection is not empty. Move or delete its books first.');
        }
        await this.storage.deleteCollection(id);
        await this.load();
    }

    /**
     * Rule for collection name when starting a new game.
     * Format: `${profile.name} · ${scenario.name}`.
     */
    formatNewGameName(profile: { name: string }, scenario: Scenario): string {
        const playerName = profile.name?.trim() || 'Untitled';
        const scenarioName = scenario.name?.trim() || 'Adventure';
        return `${playerName} · ${scenarioName}`;
    }

    async createForNewGame(profile: { name: string }, scenario: Scenario): Promise<Collection> {
        return this.create(this.formatNewGameName(profile, scenario));
    }

    /**
     * Reassigns a book to another collection. The target must exist.
     */
    async moveBook(bookId: string, targetCollectionId: string): Promise<void> {
        const target = await this.storage.getCollection(targetCollectionId);
        if (!target) throw new Error('Target collection does not exist.');
        const book = await this.storage.getBook(bookId);
        if (!book) throw new Error(`Book ${bookId} not found.`);
        if (book.collectionId === targetCollectionId) return;
        book.collectionId = targetCollectionId;
        // Bump lastActiveAt so cloud sync detects this as a newer record.
        book.lastActiveAt = Date.now();
        await this.storage.saveBook(book);
    }
}
