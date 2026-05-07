import { Injectable, inject } from '@angular/core';
import { IdbBootstrap, IdbStore } from './idb-bootstrap.service';
import { StorageValue } from '../../models/types';

/**
 * The app config snapshot lives at chat_store/'settings' for legacy reasons
 * (chat_store predates the per-domain stores). AppConfigStore is the source
 * of truth; this repository just owns the persisted mirror used by JSON
 * export / Drive sync.
 */
@Injectable({ providedIn: 'root' })
export class SettingsRepository {
    private store = new IdbStore<StorageValue>(inject(IdbBootstrap).db, 'chat_store');

    get<T = unknown>(): Promise<T | undefined> {
        return this.store.get('settings') as Promise<T | undefined>;
    }

    save(snapshot: unknown): Promise<void> {
        return this.store.put('settings', snapshot as StorageValue);
    }
}
