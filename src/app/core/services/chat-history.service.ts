import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { StorageService } from './storage.service';
import { SessionService } from './session.service';
import { ChatMessage, ExtendedPart } from '../models/types';

/**
 * Service responsible for chat history CRUD operations.
 * All state is stored in GameStateService; this service handles mutations.
 *
 * Edit-style methods (`updateMessageContent`, `deleteMessage`, etc.) persist
 * the chat to local storage AND save the active book — the two stores must
 * stay in lockstep for the book list / sync to see edits, so the book write
 * is part of the method contract, not a caller responsibility.
 */
@Injectable({
    providedIn: 'root'
})
export class ChatHistoryService {
    private state = inject(GameStateService);
    private storage = inject(StorageService);
    private session = inject(SessionService);

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
     * Updates the content of a specific message by ID. Also rewrites the last
     * non-thought text part so the LLM history view (which prefers `parts`
     * over `content` when both exist) reflects the edit.
     */
    async updateMessageContent(id: string, newContent: string) {
        this.state.messages.update(msgs =>
            msgs.map(m => {
                if (m.id !== id) return m;
                return { ...m, content: newContent, parts: this.replaceLastTextPart(m.parts, newContent) };
            })
        );
        this.storage.set('chat_history', this.state.messages());
        await this.session.saveCurrentSessionToBook();
    }

    private replaceLastTextPart(parts: ExtendedPart[] | undefined, newText: string): ExtendedPart[] {
        if (!parts || parts.length === 0) return [{ text: newText }];
        // Walk from the end for the last visible text part — thought parts and
        // function-call parts must keep their original payload.
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            if (p.text !== undefined && !(p as ExtendedPart).thought) {
                const next = [...parts];
                next[i] = { ...p, text: newText };
                return next;
            }
        }
        // No editable text part — append one so the edit is at least visible.
        return [...parts, { text: newText }];
    }

    /**
     * Updates the logs (inventory, quest, world or character) of a specific message by ID.
     */
    async updateMessageLogs(id: string, type: 'inventory' | 'quest' | 'world' | 'character', logs: string[]) {
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
        await this.session.saveCurrentSessionToBook();
    }

    /**
     * Updates the narrative summary of a specific message by ID.
     */
    async updateMessageSummary(id: string, summary: string) {
        this.state.messages.update(msgs =>
            msgs.map(m => (m.id === id ? { ...m, summary } : m))
        );
        this.storage.set('chat_history', this.state.messages());
        await this.session.saveCurrentSessionToBook();
    }

    /**
     * Updates the correction note of a specific message by ID.
     */
    async updateMessageCorrection(id: string, correction: string) {
        this.state.messages.update(msgs =>
            msgs.map(m => (m.id === id ? { ...m, correction } : m))
        );
        this.storage.set('chat_history', this.state.messages());
        await this.session.saveCurrentSessionToBook();
    }

    /**
     * Deletes a specific message from the chat history.
     */
    async deleteMessage(id: string) {
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
        await this.session.saveCurrentSessionToBook();
    }

    /** Batch delete; single pass + one book save at the end instead of N. */
    async deleteMessages(ids: string[]) {
        if (ids.length === 0) return;
        const idSet = new Set(ids);
        this.updateMessages(prev => {
            const removed: ChatMessage[] = [];
            const remaining = prev.filter(m => {
                if (idSet.has(m.id)) {
                    removed.push(m);
                    return false;
                }
                return true;
            });
            if (removed.length > 0) {
                this.accumulateSunkUsage(this.calculateSunkUsage(removed));
            }
            return remaining;
        });
        await this.session.saveCurrentSessionToBook();
    }

    /**
     * Deletes all messages from a specific message onwards (inclusive).
     */
    async deleteFrom(id: string) {
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
        await this.session.saveCurrentSessionToBook();
    }

    /**
     * Rewinds the story history to just before a specific message.
     */
    async rewindTo(messageId: string) {
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
        await this.session.saveCurrentSessionToBook();
    }

    /**
     * Toggles a message's 'Reference Only' status.
     */
    async toggleRefOnly(id: string) {
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
        await this.session.saveCurrentSessionToBook();
    }

    /**
     * Clears all local chat history and usage stats.
     */
    async clearHistory() {
        this.state.messages.set([]);
        this.state.tokenUsage.set({ freshInput: 0, cached: 0, output: 0, total: 0 });
        this.state.lastTurnCost.set(0);
        this.state.storageUsageAccumulated.set(0);
        this.state.historyStorageUsageAccumulated.set(0);
        this.state.sunkUsageHistory.set([]);

        await this.storage.delete('chat_history');
        await this.storage.delete('sunk_usage_history');
        this.state.status.set('idle');
        await this.session.saveCurrentSessionToBook();
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
                    cached: msg.usage.cached || 0,
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
                this.storage.set('sunk_usage_history', newVal).catch(e => console.error('Failed to save sunk usage history to IDB', e));
                return newVal;
            });
        }
    }
}
