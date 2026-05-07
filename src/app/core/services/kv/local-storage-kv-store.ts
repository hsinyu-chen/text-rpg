/* eslint-disable no-restricted-globals -- this file IS the KVStore implementation; it is the one allowed wrapper around the localStorage global. */
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

    keys(): string[] {
        const out: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k !== null) out.push(k);
        }
        return out;
    }
}
