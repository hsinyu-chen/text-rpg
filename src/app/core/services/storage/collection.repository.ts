import { Injectable, inject } from '@angular/core';
import { IdbBootstrap, IdbStore } from './idb-bootstrap.service';
import { Collection } from '../../models/types';
import { cleanCollectionForSync } from '../sync/clean.util';

@Injectable({ providedIn: 'root' })
export class CollectionRepository {
    private store = new IdbStore<Collection>(inject(IdbBootstrap).db, 'collections_store');

    list(): Promise<Collection[]> { return this.store.getAll(); }
    get(id: string): Promise<Collection | undefined> { return this.store.get(id); }

    save(collection: Collection): Promise<void> {
        const clean = cleanCollectionForSync(collection);
        return this.store.put(clean.id, clean);
    }

    delete(id: string): Promise<void> { return this.store.delete(id); }
}
