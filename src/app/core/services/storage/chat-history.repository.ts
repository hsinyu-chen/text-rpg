import { Injectable, inject } from '@angular/core';
import { IdbBootstrap, IdbStore } from './idb-bootstrap.service';
import { ChatMessage, StorageValue } from '../../models/types';

/**
 * Two chat_store keys: `chat_history` (turn log) and `sunk_usage_history`
 * (sunk usage stream). Callers that need to wipe both call `deleteMessages`
 * and `deleteSunkUsage` explicitly — there is intentionally no `deleteAll`,
 * because chat_store also holds rows owned by other domains.
 */
@Injectable({ providedIn: 'root' })
export class ChatHistoryRepository {
    private store = new IdbStore<StorageValue>(inject(IdbBootstrap).db, 'chat_store');

    getMessages(): Promise<ChatMessage[] | undefined> {
        return this.store.get('chat_history') as Promise<ChatMessage[] | undefined>;
    }

    saveMessages(messages: ChatMessage[]): Promise<void> {
        return this.store.put('chat_history', messages);
    }

    deleteMessages(): Promise<void> { return this.store.delete('chat_history'); }

    getSunkUsage<T = unknown>(): Promise<T | undefined> {
        return this.store.get('sunk_usage_history') as Promise<T | undefined>;
    }

    saveSunkUsage(value: unknown): Promise<void> {
        return this.store.put('sunk_usage_history', value as StorageValue);
    }

    deleteSunkUsage(): Promise<void> { return this.store.delete('sunk_usage_history'); }
}
