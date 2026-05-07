import { Injectable, inject } from '@angular/core';
import { IdbBootstrap, IdbStore, StoredProfileMeta } from './idb-bootstrap.service';

@Injectable({ providedIn: 'root' })
export class ProfileMetaRepository {
    private store = new IdbStore<StoredProfileMeta>(inject(IdbBootstrap).db, 'prompt_profile_meta');

    list(): Promise<StoredProfileMeta[]> { return this.store.getAll(); }
    get(id: string): Promise<StoredProfileMeta | undefined> { return this.store.get(id); }
    put(meta: StoredProfileMeta): Promise<void> { return this.store.put(meta.id, meta); }
    delete(id: string): Promise<void> { return this.store.delete(id); }
}
