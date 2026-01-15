import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { StorageService } from './storage.service';
import { ChatMessage } from '../models/types';

/**
 * Service responsible for chat history CRUD operations.
 * All state is stored in GameStateService; this service handles mutations.
 */
@Injectable({
    providedIn: 'root'
})
export class ChatHistoryService {
    private state = inject(GameStateService);
    private storage = inject(StorageService);

    /**
     * Updates the chat history state and persists it to local storage.
     * @param updater Functional update to the message list.
     */
    updateMessages(updater: (prev: ChatMessage[]) => ChatMessage[]) {
        const newVal = updater(this.state.messages());
        this.state.messages.set(newVal);
        this.storage.set('chat_history', newVal);
    }

    /**
     * Updates the content of a specific message by ID.
     */
    updateMessageContent(id: string, newContent: string) {
        this.state.messages.update(msgs =>
            msgs.map(m => (m.id === id ? { ...m, content: newContent } : m))
        );
        this.storage.set('chat_history', this.state.messages());
    }

    /**
     * Updates the logs (inventory, quest or world) of a specific message by ID.
     */
    updateMessageLogs(id: string, type: 'inventory' | 'quest' | 'world', logs: string[]) {
        this.state.messages.update(msgs =>
            msgs.map(m => {
                if (m.id === id) {
                    const updates: Partial<ChatMessage> = {};
                    if (type === 'inventory') updates.inventory_log = logs;
                    else if (type === 'quest') updates.quest_log = logs;
                    else if (type === 'world') updates.world_log = logs;
                    return { ...m, ...updates };
                }
                return m;
            })
        );
        this.storage.set('chat_history', this.state.messages());
    }

    /**
     * Updates the narrative summary of a specific message by ID.
     */
    updateMessageSummary(id: string, summary: string) {
        this.state.messages.update(msgs =>
            msgs.map(m => (m.id === id ? { ...m, summary } : m))
        );
        this.storage.set('chat_history', this.state.messages());
    }

    /**
     * Deletes a specific message from the chat history.
     */
    deleteMessage(id: string) {
        this.updateMessages(prev => {
            const arr = [...prev];
            const index = arr.findIndex(m => m.id === id);
            if (index !== -1) arr.splice(index, 1);
            return arr;
        });
    }

    /**
     * Deletes all messages from a specific message onwards (inclusive).
     */
    deleteFrom(id: string) {
        this.updateMessages(prev => {
            const arr = [...prev];
            const index = arr.findIndex(m => m.id === id);
            if (index !== -1) arr.splice(index);
            return arr;
        });
    }

    /**
     * Rewinds the story history to just before a specific message.
     */
    rewindTo(messageId: string) {
        this.updateMessages(prev => {
            const arr = [...prev];
            const index = arr.findIndex(m => m.id === messageId);
            if (index !== -1) {
                arr.splice(index);
                console.log(
                    `[ChatHistory] Rewound history to before message ${messageId} (Deleted ${prev.length - arr.length} messages)`
                );
            }
            return arr;
        });
    }

    /**
     * Toggles a message's 'Reference Only' status.
     */
    toggleRefOnly(id: string) {
        this.updateMessages(prev => {
            const arr = [...prev];
            const index = arr.findIndex(m => m.id === id);
            if (index !== -1) {
                arr[index] = {
                    ...arr[index],
                    isRefOnly: !arr[index].isRefOnly,
                    isManualRefOnly: true
                };
            }
            return arr;
        });
    }

    /**
     * Clears all local chat history and usage stats.
     */
    async clearHistory() {
        this.state.messages.set([]);
        this.state.tokenUsage.set({ freshInput: 0, cached: 0, output: 0, total: 0 });
        this.state.lastTurnCost.set(0);
        this.state.estimatedCost.set(0);
        this.state.storageCostAccumulated.set(0);
        this.state.historyStorageCostAccumulated.set(0);

        localStorage.removeItem('usage_stats');
        localStorage.removeItem('estimated_cost');
        localStorage.removeItem('storage_cost_acc');
        localStorage.removeItem('history_storage_cost_acc');

        await this.storage.delete('chat_history');
        this.state.status.set('idle');
    }
}
