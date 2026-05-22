import { Injectable, inject, signal, linkedSignal, computed } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { DialogService } from '@app/core/services/dialog.service';
import { SessionService } from '@app/core/services/session.service';
import { BookRepository } from '@app/core/services/storage/book.repository';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ChatMessage } from '@app/core/models/types';
import { I18nService } from '@app/core/i18n';

@Injectable()
export class MessageStateService {
    private engine = inject(GameEngineService);
    private gameState = inject(GameStateService);
    private dialog = inject(DialogService);
    private session = inject(SessionService);
    private books = inject(BookRepository);
    private snackBar = inject(MatSnackBar);
    private clipboard = inject(Clipboard);
    private i18n = inject(I18nService);

    // Reactive sources initialized by the component
    message = signal<ChatMessage>(null!);
    index = signal<number>(0);

    // Local UI State
    isUpdateVisible = linkedSignal({
        // Only reset when content presence changes (e.g. from none to some)
        source: () => !!(this.message()?.summary || (this.message()?.character_log?.length ?? 0) > 0 || (this.message()?.inventory_log?.length ?? 0) > 0 || (this.message()?.quest_log?.length ?? 0) > 0 || (this.message()?.world_log?.length ?? 0) > 0 || !!this.message()?.correction),
        computation: (hasContent) => hasContent
    });

    // Auto-expand/collapse analysis based on thinking state transition
    isAnalysisVisible = linkedSignal({
        source: () => this.message()?.isThinking,
        computation: (isThinking) => isThinking ?? false
    });

    // Engine drives this via `cotOpen`: true when a thought phase starts (turn
    // begin / narrator phase begin in two-call), false on the first non-thought
    // chunk. linkedSignal lets the user override mid-phase; the override holds
    // until cotOpen flips again. Source is wrapped in computed() so spurious
    // re-emits with the same boolean don't wipe the user's manual toggle.
    private cotOpenSource = computed(() => this.message()?.cotOpen ?? false);
    isThoughtVisible = linkedSignal({
        source: this.cotOpenSource,
        computation: (cotOpen) => cotOpen
    });

    isRaw = signal(false);

    isRefExpanded = signal(false);
    isEditing = signal(false);
    editContent = signal('');

    isEditingSummary = signal(false);
    editSummaryContent = signal('');

    isEditingCorrection = signal(false);
    editCorrectionContent = signal('');

    editingLogKey = signal<string | null>(null);
    editingLogContent = signal('');
    private isAddingNew = false;

    // Computed
    inContext = computed(() => {
        const all = this.gameState.messages();
        const idx = this.index();
        const msg = all[idx];
        if (!msg || msg.isRefOnly) return false;

        let relevantAfter = 0;
        for (let i = idx + 1; i < all.length; i++) {
            if (!all[i].isRefOnly || all[i].parts?.some(p => p.functionResponse)) {
                relevantAfter++;
            }
        }
        return relevantAfter < 5;
    });

    // Methods
    toggleUpdate() { this.isUpdateVisible.update(v => !v); }
    toggleAnalysis() { this.isAnalysisVisible.update(v => !v); }
    toggleThought() { this.isThoughtVisible.update(v => !v); }
    toggleRaw() { this.isRaw.update(v => !v); }
    toggleRefExpanded() { this.isRefExpanded.update(v => !v); }

    toggleRefOnly() {
        void this.engine.toggleRefOnly(this.message().id);
    }

    async deleteMessage() {
        const ok = await this.dialog.confirm(this.i18n.translate('ui.DELETE_MESSAGE_CONFIRM'));
        if (ok) await this.engine.deleteMessage(this.message().id);
    }

    async deleteMessageAndFollowing() {
        const ok = await this.dialog.confirm(this.i18n.translate('ui.DELETE_ALL_FOLLOWING_CONFIRM'));
        if (ok) await this.engine.deleteFrom(this.message().id);
    }

    async forkFromHere() {
        if (this.gameState.isBusy()) return;
        const sourceId = this.session.currentBookId();
        if (!sourceId) return;
        const sourceBook = await this.books.get(sourceId);
        const defaultName = sourceBook?.name
            ? this.i18n.translate('ui.FORK_FROM_HERE_DEFAULT_NAME', { name: sourceBook.name })
            : 'Fork';
        const name = await this.dialog.prompt(this.i18n.translate('ui.FORK_FROM_HERE_PROMPT'), {
            title: this.i18n.translate('ui.FORK_FROM_HERE_TITLE'),
            defaultValue: defaultName,
        });
        if (!name) return;
        try {
            await this.session.forkBookFromMessage(sourceId, this.message().id, name);
            this.snackBar.open(
                this.i18n.translate('ui.FORK_FROM_HERE_SUCCESS', { name }),
                this.i18n.translate('ui.CLOSE'),
                { duration: 3000 },
            );
        } catch (e) {
            console.error('[MessageStateService] forkFromHere failed', e);
            this.snackBar.open(
                this.i18n.translate('ui.FORK_FROM_HERE_FAILED'),
                this.i18n.translate('ui.CLOSE'),
                { duration: 3000 },
            );
        }
    }

    enterEditMode() {
        this.editContent.set(this.message().content);
        this.isEditing.set(true);
    }

    cancelEdit() {
        this.isEditing.set(false);
    }

    async saveEdit() {
        await this.engine.updateMessageContent(this.message().id, this.editContent());
        this.isEditing.set(false);
    }



    copyPairJSON() {
        const all = this.gameState.messages();
        const idx = this.index();
        const modelMsg = all[idx];
        const prevMsg = idx > 0 ? all[idx - 1] : null;

        const pair = {
            user: prevMsg?.role === 'user' ? {
                intent: prevMsg.intent,
                content: prevMsg.content
            } : null,
            model: {
                thought: modelMsg.thought,
                analysis: modelMsg.analysis,
                summary: modelMsg.summary,
                character_log: modelMsg.character_log,
                inventory_log: modelMsg.inventory_log,
                quest_log: modelMsg.quest_log,
                world_log: modelMsg.world_log,
                content: modelMsg.content
            }
        };

        this.clipboard.copy(JSON.stringify(pair, null, 2));
        this.snackBar.open(this.i18n.translate('ui.PAIR_JSON_COPIED'), this.i18n.translate('ui.CLOSE'), { duration: 2000 });
    }

    // Log Item Logic
    addLogItem(type: 'inv' | 'quest' | 'world' | 'char') {
        const items = type === 'inv' ? [...(this.message().inventory_log || [])] :
            type === 'quest' ? [...(this.message().quest_log || [])] :
                type === 'world' ? [...(this.message().world_log || [])] :
                    [...(this.message().character_log || [])];

        items.push(this.i18n.translate('ui.NEW_ITEM_DEFAULT'));
        const engineType = type === 'inv' ? 'inventory' : type === 'quest' ? 'quest' : type === 'world' ? 'world' : 'character';
        void this.engine.updateMessageLogs(this.message().id, engineType, items);

        const idx = items.length - 1;
        this.startLogEdit(type, idx, 'New Item', true);
    }

    startLogEdit(type: 'inv' | 'quest' | 'world' | 'char', index: number, content: string, isAdding = false) {
        this.isAddingNew = isAdding;
        this.editingLogKey.set(`${this.message().id}|${type}|${index}`);
        this.editingLogContent.set(content);
        // Input focus + select is handled by the appAutofocusSelect directive on
        // the rendered input element.
    }

    async saveLogEdit(type: 'inv' | 'quest' | 'world' | 'char', index: number) {
        const items = type === 'inv' ? [...(this.message().inventory_log || [])] :
            type === 'quest' ? [...(this.message().quest_log || [])] :
                type === 'world' ? [...(this.message().world_log || [])] :
                    [...(this.message().character_log || [])];

        items[index] = this.editingLogContent();
        const engineType = type === 'inv' ? 'inventory' : type === 'quest' ? 'quest' : type === 'world' ? 'world' : 'character';
        await this.engine.updateMessageLogs(this.message().id, engineType, items);
        this.isAddingNew = false;
        this.cancelLogEdit();
    }

    cancelLogEdit() {
        if (this.isAddingNew) {
            const currentKey = this.editingLogKey();
            if (currentKey) {
                const parts = currentKey.split('|');
                const type = parts[1] as 'inv' | 'quest' | 'world' | 'char';
                const index = parseInt(parts[2], 10);
                void this.deleteLogItem(type, index);
            }
            this.isAddingNew = false;
        }
        this.editingLogKey.set(null);
    }

    async deleteLogItem(type: 'inv' | 'quest' | 'world' | 'char', index: number) {
        const items = type === 'inv' ? [...(this.message().inventory_log || [])] :
            type === 'quest' ? [...(this.message().quest_log || [])] :
                type === 'world' ? [...(this.message().world_log || [])] :
                    [...(this.message().character_log || [])];

        items.splice(index, 1);
        const engineType = type === 'inv' ? 'inventory' : type === 'quest' ? 'quest' : type === 'world' ? 'world' : 'character';
        await this.engine.updateMessageLogs(this.message().id, engineType, items);
    }

    // Summary Edit Logic
    startSummaryEdit(content: string) {
        this.editSummaryContent.set(content);
        this.isEditingSummary.set(true);
        // Input focus + select is handled by the appAutofocusSelect directive on
        // the rendered input element.
    }

    async saveSummaryEdit() {
        await this.engine.updateMessageSummary(this.message().id, this.editSummaryContent());
        this.cancelSummaryEdit();
    }

    cancelSummaryEdit() {
        this.isEditingSummary.set(false);
    }

    // Correction Edit Logic
    startCorrectionEdit(content: string) {
        this.editCorrectionContent.set(content);
        this.isEditingCorrection.set(true);
    }

    async saveCorrectionEdit() {
        await this.engine.updateMessageCorrection(this.message().id, this.editCorrectionContent());
        this.cancelCorrectionEdit();
    }

    cancelCorrectionEdit() {
        this.isEditingCorrection.set(false);
    }

    async deleteCorrection() {
        await this.engine.updateMessageCorrection(this.message().id, '');
    }
}
