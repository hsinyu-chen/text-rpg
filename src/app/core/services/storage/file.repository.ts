import { Injectable, inject } from '@angular/core';
import { IdbBootstrap, IdbStore } from './idb-bootstrap.service';

interface FileRow { name: string; content: string; lastModified: number; tokens?: number }

@Injectable({ providedIn: 'root' })
export class FileRepository {
    private store = new IdbStore<FileRow>(inject(IdbBootstrap).db, 'file_store');

    get(name: string): Promise<FileRow | undefined> { return this.store.get(name); }
    list(): Promise<FileRow[]> { return this.store.getAll(); }
    delete(name: string): Promise<void> { return this.store.delete(name); }
    clear(): Promise<void> { return this.store.clear(); }

    save(name: string, content: string, tokens?: number): Promise<void> {
        return this.store.put(name, { name, content, tokens, lastModified: Date.now() });
    }
}
