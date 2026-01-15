import { Injectable, inject, signal, linkedSignal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { GameEngineService } from '../../../../core/services/game-engine.service';
import { GameStateService } from '../../../../core/services/game-state.service';
import { DialogService } from '../../../../core/services/dialog.service';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FileUpdateService } from '../../../../core/services/file-update.service';
import { ChatMessage } from '../../../../core/models/types';
import { AutoUpdateDialogComponent } from '../../../../shared/components/auto-update-dialog/auto-update-dialog.component';

import { GAME_INTENTS } from '../../../../core/constants/game-intents';

@Injectable()
export class MessageStateService {
    private engine = inject(GameEngineService);
    private gameState = inject(GameStateService);
    private dialog = inject(DialogService);
    private matDialog = inject(MatDialog);
    private snackBar = inject(MatSnackBar);
    private updateService = inject(FileUpdateService);

    // Reactive sources initialized by the component
    message = signal<ChatMessage>(null!);
    index = signal<number>(0);

    // Local UI State
    isUpdateVisible = linkedSignal({
        // Only reset when content presence changes (e.g. from none to some)
        source: () => !!(this.message()?.summary || (this.message()?.character_log?.length ?? 0) > 0 || (this.message()?.inventory_log?.length ?? 0) > 0 || (this.message()?.quest_log?.length ?? 0) > 0 || (this.message()?.world_log?.length ?? 0) > 0),
        computation: (hasContent) => hasContent
    });

    // Auto-expand/collapse analysis based on thinking state transition
    isAnalysisVisible = linkedSignal({
        source: () => this.message()?.isThinking,
        computation: (isThinking) => isThinking ?? false
    });

    // Auto-expand on start thinking, auto-collapse on finish thinking
    isThoughtVisible = linkedSignal({
        source: () => this.message()?.isThinking,
        computation: (isThinking) => isThinking ?? false
    });

    isRaw = linkedSignal({
        source: this.message,
        computation: (msg) => (msg?.intent === GAME_INTENTS.SAVE || msg?.content.includes('<save>')) // Should check for tag if content based? 'save' is ID.
    });

    isRefExpanded = signal(false);
    isEditing = signal(false);
    editContent = signal('');

    isEditingSummary = signal(false);
    editSummaryContent = signal('');

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
        this.engine.toggleRefOnly(this.message().id);
    }

    async deleteMessage() {
        const ok = await this.dialog.confirm('Delete this message?');
        if (ok) this.engine.deleteMessage(this.message().id);
    }

    async deleteMessageAndFollowing() {
        const ok = await this.dialog.confirm('Delete this and ALL following messages? (Irreversible)');
        if (ok) this.engine.deleteFrom(this.message().id);
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

    async openAutoUpdateDialog() {
        const msg = this.message();
        if (msg.role !== 'model') return;

        const updates = this.updateService.parseUpdates(msg.content);
        if (updates.length === 0) {
            this.dialog.alert('No file updates found in this message.');
            return;
        }

        const dialogRef = this.matDialog.open(AutoUpdateDialogComponent, {
            data: { updates },
            panelClass: 'fullscreen-dialog'
        });

        const result = await firstValueFrom(dialogRef.afterClosed());
        if (result && Array.isArray(result) && result.length > 0) {
            const results = await this.updateService.applyUpdates(result);
            await this.engine.loadFiles(false);
            this.snackBar.open(`Applied ${results.length} file updates.`, 'OK', { duration: 3000 });
        }
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

        navigator.clipboard.writeText(JSON.stringify(pair, null, 2));
        this.snackBar.open('Pair JSON copied to clipboard', 'OK', { duration: 2000 });
    }

    // Log Item Logic
    addLogItem(type: 'inv' | 'quest' | 'world' | 'char') {
        const items = type === 'inv' ? [...(this.message().inventory_log || [])] :
            type === 'quest' ? [...(this.message().quest_log || [])] :
                type === 'world' ? [...(this.message().world_log || [])] :
                    [...(this.message().character_log || [])];

        items.push('New Item');
        const engineType = type === 'inv' ? 'inventory' : type === 'quest' ? 'quest' : type === 'world' ? 'world' : 'character';
        this.engine.updateMessageLogs(this.message().id, engineType, items);

        const idx = items.length - 1;
        this.startLogEdit(type, idx, 'New Item', true);
    }

    startLogEdit(type: 'inv' | 'quest' | 'world' | 'char', index: number, content: string, isAdding = false) {
        this.isAddingNew = isAdding;
        this.editingLogKey.set(`${this.message().id}|${type}|${index}`);
        this.editingLogContent.set(content);
        setTimeout(() => {
            const inputEl = document.querySelector('.log-editor input') as HTMLInputElement;
            inputEl?.focus();
            inputEl?.select();
        }, 10);
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
                this.deleteLogItem(type, index);
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
        setTimeout(() => {
            const inputEl = document.querySelector('.summary-editor input') as HTMLInputElement;
            inputEl?.focus();
            inputEl?.select();
        }, 10);
    }

    async saveSummaryEdit() {
        await this.engine.updateMessageSummary(this.message().id, this.editSummaryContent());
        this.cancelSummaryEdit();
    }

    cancelSummaryEdit() {
        this.isEditingSummary.set(false);
    }
}
