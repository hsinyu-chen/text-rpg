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
     * Updates the logs (inventory, quest, world or character) of a specific message by ID.
     */
    updateMessageLogs(id: string, type: 'inventory' | 'quest' | 'world' | 'character', logs: string[]) {
        this.state.messages.update(msgs =>
            msgs.map(m => {
                if (m.id === id) {
                    const updates: Partial<ChatMessage> = {};
                    if (type === 'inventory') updates.inventory_log = logs;
                    else if (type === 'quest') updates.quest_log = logs;
                    else if (type === 'world') updates.world_log = logs;
                    else if (type === 'character') updates.character_log = logs;
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
            if (index !== -1) {
                // Accumulate sunk usage history
                const usages = this.calculateSunkUsage([arr[index]]);
                this.accumulateSunkUsage(usages);
                arr.splice(index, 1);
            }
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
            if (index !== -1) {
                // Accumulate sunk usage history for ALL removed messages
                const removedMessages = arr.slice(index);
                const usages = this.calculateSunkUsage(removedMessages);
                this.accumulateSunkUsage(usages);
                arr.splice(index);
            }
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
                // Accumulate sunk usage history: everything AFTER `index`
                const removedMessages = arr.slice(index);
                const usages = this.calculateSunkUsage(removedMessages);
                this.accumulateSunkUsage(usages);

                arr.splice(index);
                console.log(
                    `[ChatHistory] Rewound history to before message ${messageId} (Deleted ${removedMessages.length} messages, Sunk Items: ${usages.length})`
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
        this.state.storageUsageAccumulated.set(0);
        this.state.historyStorageUsageAccumulated.set(0);
        this.state.sunkUsageHistory.set([]);

        localStorage.removeItem('usage_stats');
        localStorage.removeItem('estimated_cost');
        localStorage.removeItem('storage_cost_acc');
        localStorage.removeItem('history_storage_cost_acc');
        localStorage.removeItem('sunk_usage_history');

        localStorage.removeItem('kb_storage_usage_acc');
        localStorage.removeItem('history_storage_usage_acc');

        await this.storage.delete('chat_history');
        await this.storage.delete('sunk_usage_history');
        this.state.status.set('idle');
    }

    /**
     * Public method to manually record sunk usage (e.g., for cache creation).
     */
    public recordSunkUsage(prompt: number, cached: number, candidates: number) {
        this.accumulateSunkUsage([{ prompt, cached, candidates }]);
    }

    /**
     * Extracts individual usage metrics from model messages.
     */
    private calculateSunkUsage(messages: ChatMessage[]): { prompt: number, cached: number, candidates: number }[] {
        const history: { prompt: number, cached: number, candidates: number }[] = [];

        for (const msg of messages) {
            if (msg.role === 'model' && msg.usage) {
                history.push({
                    prompt: msg.usage.prompt,
                    cached: msg.usage.cached,
                    candidates: msg.usage.candidates
                });
            }
        }
        return history;
    }

    /**
     * Appends to the sunk usage history and persists it.
     */
    private accumulateSunkUsage(newUsages: { prompt: number, cached: number, candidates: number }[]) {
        if (newUsages.length > 0) {
            this.state.sunkUsageHistory.update(v => {
                const newVal = [...v, ...newUsages];
                localStorage.setItem('sunk_usage_history', JSON.stringify(newVal));
                this.storage.set('sunk_usage_history', newVal).catch(e => console.error('Failed to save sunk usage history to IDB', e));
                return newVal;
            });
        }
    }
}
