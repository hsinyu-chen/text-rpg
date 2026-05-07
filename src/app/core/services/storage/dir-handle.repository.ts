import { Injectable, inject } from '@angular/core';
import { IdbBootstrap, IdbStore } from './idb-bootstrap.service';

@Injectable({ providedIn: 'root' })
export class DirHandleRepository {
    private store = new IdbStore<FileSystemDirectoryHandle>(inject(IdbBootstrap).db, 'sync_handles');

    get(key: string): Promise<FileSystemDirectoryHandle | undefined> { return this.store.get(key); }
    set(key: string, handle: FileSystemDirectoryHandle): Promise<void> { return this.store.put(key, handle); }
    delete(key: string): Promise<void> { return this.store.delete(key); }
}
