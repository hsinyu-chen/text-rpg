import { Injectable } from '@angular/core';
import { KVStore } from './kv-store';

/**
 * Production {@link KVStore} backed by `window.localStorage`. The single
 * place in the app that talks to the raw global; everyone else takes
 * `KVStore` via DI.
 */
@Injectable({ providedIn: 'root' })
export class LocalStorageKVStore extends KVStore {
    get(key: string): string | null {
        return localStorage.getItem(key);
    }

    set(key: string, value: string): void {
        localStorage.setItem(key, value);
    }

    remove(key: string): void {
        localStorage.removeItem(key);
    }
}
