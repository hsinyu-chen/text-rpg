import { Injectable, inject } from '@angular/core';
import { IdbBootstrap, IdbStore } from './idb-bootstrap.service';
import { ChatMessage, StorageValue } from '../../models/types';

/**
 * chat_store is a small KV bag. Two of its keys are chat-state:
 * `chat_history` (turn log) and `sunk_usage_history` (sunk usage stream).
 * The third key (`settings`) is owned by SettingsRepository so consumers
 * don't see chat / settings as the same domain.
 *
 * `deleteAll()` wipes the whole chat_store and is the safe path for
 * "clear chat" — settings live alongside but are re-snapshotted on the
 * next saveConfig.
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

    /** Wipes the whole chat_store — also clears the settings snapshot, which
     * is fine because it gets re-written from AppConfigStore on the next save. */
    deleteAll(): Promise<void> { return this.store.clear(); }
}
