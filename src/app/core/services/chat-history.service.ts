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
     * Returns the persistence promise so callers that need lockstep with the
     * subsequent book save can await it. Fire-and-forget callers (e.g. the
     * engine's stream-chunk updater) may ignore the return value.
     */
    updateMessages(updater: (prev: ChatMessage[]) => ChatMessage[]): Promise<void> {
        const newVal = updater(this.state.messages());
        this.state.messages.set(newVal);
        return this.storage.set('chat_history', newVal);
    }

    /**
     * Updates the content of a specific message by ID. Also rewrites the last
     * non-thought text part so the LLM history view (which prefers `parts`
     * over `content` when both exist) reflects the edit.
     */
    async updateMessageContent(id: string, newContent: string) {
        await this.updateMessages(msgs =>
            msgs.map(m => {
                if (m.id !== id) return m;
                return { ...m, content: newContent, parts: this.replaceLastTextPart(m.parts, newContent) };
            })
        );
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
        await this.updateMessages(msgs =>
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
        await this.session.saveCurrentSessionToBook();
    }

    /** Updates the narrative summary of a specific message by ID. */
    async updateMessageSummary(id: string, summary: string) {
        await this.updateMessages(msgs =>
            msgs.map(m => (m.id === id ? { ...m, summary } : m))
        );
        await this.session.saveCurrentSessionToBook();
    }

    /** Updates the correction note of a specific message by ID. */
    async updateMessageCorrection(id: string, correction: string) {
        await this.updateMessages(msgs =>
            msgs.map(m => (m.id === id ? { ...m, correction } : m))
        );
        await this.session.saveCurrentSessionToBook();
    }

    /** Deletes a specific message from the chat history. */
    async deleteMessage(id: string) {
        const current = this.state.messages();
        const index = current.findIndex(m => m.id === id);
        if (index === -1) return;
        const removed = current[index];
        const remaining = [...current.slice(0, index), ...current.slice(index + 1)];
        await this.updateMessages(() => remaining);
        await this.accumulateSunkUsage(this.calculateSunkUsage([removed]));
        await this.session.saveCurrentSessionToBook();
    }

    /** Batch delete; single pass + one book save at the end instead of N. */
    async deleteMessages(ids: string[]) {
        if (ids.length === 0) return;
        const idSet = new Set(ids);
        const current = this.state.messages();
        const removed: ChatMessage[] = [];
        const remaining: ChatMessage[] = [];
        for (const m of current) {
            (idSet.has(m.id) ? removed : remaining).push(m);
        }
        if (removed.length === 0) return;
        await this.updateMessages(() => remaining);
        await this.accumulateSunkUsage(this.calculateSunkUsage(removed));
        await this.session.saveCurrentSessionToBook();
    }

    /** Deletes all messages from a specific message onwards (inclusive). */
    async deleteFrom(id: string) {
        const current = this.state.messages();
        const index = current.findIndex(m => m.id === id);
        if (index === -1) return;
        const removed = current.slice(index);
        const remaining = current.slice(0, index);
        await this.updateMessages(() => remaining);
        await this.accumulateSunkUsage(this.calculateSunkUsage(removed));
        await this.session.saveCurrentSessionToBook();
    }

    /** Rewinds the story history to just before a specific message. */
    async rewindTo(messageId: string) {
        const current = this.state.messages();
        const index = current.findIndex(m => m.id === messageId);
        if (index === -1) return;
        const removed = current.slice(index);
        const remaining = current.slice(0, index);
        const usages = this.calculateSunkUsage(removed);
        await this.updateMessages(() => remaining);
        await this.accumulateSunkUsage(usages);
        console.log(
            `[ChatHistory] Rewound history to before message ${messageId} (Deleted ${removed.length} messages, Sunk Items: ${usages.length})`
        );
        await this.session.saveCurrentSessionToBook();
    }

    /** Toggles a message's 'Reference Only' status. */
    async toggleRefOnly(id: string) {
        const current = this.state.messages();
        const index = current.findIndex(m => m.id === id);
        if (index === -1) return;
        const next = [...current];
        next[index] = {
            ...next[index],
            isRefOnly: !next[index].isRefOnly,
            isManualRefOnly: true
        };
        await this.updateMessages(() => next);
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
        await this.session.saveCurrentSessionToBook();
    }

    /**
     * Public method to manually record sunk usage (e.g., for cache creation).
     */
    public recordSunkUsage(prompt: number, cached: number, candidates: number): Promise<void> {
        return this.accumulateSunkUsage([{ prompt, cached, candidates }]);
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

    /** Appends to the sunk usage history and persists it. */
    private async accumulateSunkUsage(newUsages: { prompt: number, cached: number, candidates: number }[]): Promise<void> {
        if (newUsages.length === 0) return;
        const newVal = [...this.state.sunkUsageHistory(), ...newUsages];
        this.state.sunkUsageHistory.set(newVal);
        try {
            await this.storage.set('sunk_usage_history', newVal);
        } catch (e) {
            console.error('Failed to save sunk usage history to IDB', e);
        }
    }
}
