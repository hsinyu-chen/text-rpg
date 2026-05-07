import { Injectable, inject } from '@angular/core';
import { IdbBootstrap, IdbStore } from './idb-bootstrap.service';
import { Book } from '../../models/types';
import { cleanBookForSync } from '../sync/clean.util';

@Injectable({ providedIn: 'root' })
export class BookRepository {
    private store = new IdbStore<Book>(inject(IdbBootstrap).db, 'books_store');

    list(): Promise<Book[]> { return this.store.getAll(); }
    get(id: string): Promise<Book | undefined> { return this.store.get(id); }

    /** Run every write through the cleaner so legacy / forward-compat fields
     * (e.g. removed `book.prompts`) never persist past this layer. */
    save(book: Book): Promise<void> {
        const clean = cleanBookForSync(book);
        return this.store.put(clean.id, clean);
    }

    delete(id: string): Promise<void> { return this.store.delete(id); }
}
