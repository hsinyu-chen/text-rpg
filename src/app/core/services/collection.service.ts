import { Injectable, inject, signal } from '@angular/core';
import { BookRepository } from './storage/book.repository';
import { CollectionRepository } from './storage/collection.repository';
import { Collection, ROOT_COLLECTION_ID, Scenario } from '../models/types';

@Injectable({ providedIn: 'root' })
export class CollectionService {
    private books = inject(BookRepository);
    private repo = inject(CollectionRepository);

    collections = signal<Collection[]>([]);

    async load(): Promise<void> {
        const list = await this.repo.list();
        this.collections.set(list.sort((a, b) => a.createdAt - b.createdAt));
    }

    async ensureRoot(): Promise<Collection> {
        const existing = await this.repo.get(ROOT_COLLECTION_ID);
        if (existing) return existing;
        const root: Collection = {
            id: ROOT_COLLECTION_ID,
            name: 'Root',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await this.repo.save(root);
        return root;
    }

    async create(name: string): Promise<Collection> {
        const c: Collection = {
            id: crypto.randomUUID(),
            name: name.trim() || 'Untitled',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await this.repo.save(c);
        await this.load();
        return c;
    }

    async rename(id: string, newName: string): Promise<void> {
        if (id === ROOT_COLLECTION_ID) {
            throw new Error('Root collection cannot be renamed.');
        }
        const c = await this.repo.get(id);
        if (!c) return;
        c.name = newName.trim() || c.name;
        c.updatedAt = Date.now();
        await this.repo.save(c);
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
        const books = await this.books.list();
        const occupied = books.some(b => b.collectionId === id);
        if (occupied) {
            throw new Error('Collection is not empty. Move or delete its books first.');
        }
        await this.repo.delete(id);
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
        const target = await this.repo.get(targetCollectionId);
        if (!target) throw new Error('Target collection does not exist.');
        const book = await this.books.get(bookId);
        if (!book) throw new Error(`Book ${bookId} not found.`);
        if (book.collectionId === targetCollectionId) return;
        book.collectionId = targetCollectionId;
        // Bump lastActiveAt so cloud sync detects this as a newer record.
        book.lastActiveAt = Date.now();
        await this.books.save(book);
    }
}
