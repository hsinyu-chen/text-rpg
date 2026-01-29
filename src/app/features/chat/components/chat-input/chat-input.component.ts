import { Component, model, ChangeDetectionStrategy, inject, output, viewChild, ElementRef, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatMenuModule } from '@angular/material/menu';
import { MatBadgeModule } from '@angular/material/badge';
import { TextFieldModule } from '@angular/cdk/text-field';
import { GAME_INTENTS, STORY_INTENTS } from '../../../../core/constants/game-intents';
import { getIntentLabels, getIntentDescriptions, getInputPlaceholders } from '../../../../core/constants/engine-protocol';
import { GameEngineService } from '../../../../core/services/game-engine.service';
import { GameStateService } from '../../../../core/services/game-state.service';
import { SessionService } from '../../../../core/services/session.service';
import { MatDialog } from '@angular/material/dialog';
import { PayloadDialogComponent } from '../../../../shared/components/payload-dialog/payload-dialog.component';
import { ChatConfigDialogComponent } from '../../../../shared/components/chat-config-dialog/chat-config-dialog.component';
import { ChatReplaceDialogComponent } from '../chat-replace-dialog/chat-replace-dialog.component';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../../../shared/components/confirm-dialog/confirm-dialog.component';
import { TauriWindow } from '../../../../core/models/types';
import { LanguageService } from '../../../../core/services/language.service';

@Component({
    selector: 'app-chat-input',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatButtonModule,
        MatIconModule,
        MatInputModule,
        MatFormFieldModule,
        MatTooltipModule,
        MatSelectModule,
        MatMenuModule,
        TextFieldModule,
        MatBadgeModule
    ],
    templateUrl: './chat-input.component.html',
    styleUrl: './chat-input.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class ChatInputComponent {
    // Services
    engine = inject(GameEngineService);
    state = inject(GameStateService);
    session = inject(SessionService);
    lang = inject(LanguageService);
    private matDialog = inject(MatDialog);

    // Computed: Whether there's an active session (book) to work with
    hasActiveSession = computed(() => !!this.session.currentBookId());

    // Queries
    messageInput = viewChild.required<ElementRef<HTMLTextAreaElement>>('messageInput');

    // Inputs/Models
    userInput = model<string>('');
    selectedIntent = model<string>(GAME_INTENTS.ACTION);
    editingMessageId = model<string | null>(null);

    // Outputs
    messageSent = output<void>();
    editCancelled = output<void>();
    toggleSidebar = output<void>();

    // Local State
    intents = Object.values(GAME_INTENTS);
    private originalIntentBeforeEdit: string | null = null;
    // Localized intent labels
    intentLabels = computed(() => getIntentLabels(this.state.config()?.outputLanguage));
    intentDescriptions = computed(() => getIntentDescriptions(this.state.config()?.outputLanguage));

    getIntentLabel(intent: string): string {
        const labels = this.intentLabels();
        // Map intent values to label keys
        if (intent === GAME_INTENTS.ACTION) return labels.ACTION;
        if (intent === GAME_INTENTS.FAST_FORWARD) return labels.FAST_FORWARD;
        if (intent === GAME_INTENTS.SYSTEM) return labels.SYSTEM;
        if (intent === GAME_INTENTS.SAVE) return labels.SAVE;
        if (intent === GAME_INTENTS.CONTINUE) return labels.CONTINUE;
        return intent; // Fallback to raw value
    }

    getIntentDescription(intent: string): string {
        const descriptions = this.intentDescriptions();
        if (intent === GAME_INTENTS.ACTION) return descriptions.ACTION;
        if (intent === GAME_INTENTS.FAST_FORWARD) return descriptions.FAST_FORWARD;
        if (intent === GAME_INTENTS.SYSTEM) return descriptions.SYSTEM;
        if (intent === GAME_INTENTS.SAVE) return descriptions.SAVE;
        if (intent === GAME_INTENTS.CONTINUE) return descriptions.CONTINUE;
        return '';
    }

    getIntentIcon(intent: string): string {
        if (intent === GAME_INTENTS.ACTION) return 'play_arrow';
        if (intent === GAME_INTENTS.FAST_FORWARD) return 'fast_forward';
        if (intent === GAME_INTENTS.SYSTEM) return 'settings';
        if (intent === GAME_INTENTS.SAVE) return 'save';
        if (intent === GAME_INTENTS.CONTINUE) return 'arrow_forward';
        return 'help';
    }

    getIntentColor(intent: string): string {
        if (intent === GAME_INTENTS.ACTION) return 'var(--intent-action)';
        if (intent === GAME_INTENTS.FAST_FORWARD) return 'var(--intent-fastforward)';
        if (intent === GAME_INTENTS.SYSTEM) return 'var(--intent-system)';
        if (intent === GAME_INTENTS.SAVE) return 'var(--intent-save)';
        if (intent === GAME_INTENTS.CONTINUE) return 'var(--intent-continue)';
        return 'inherit';
    }

    dynamicPlaceholder = computed(() => {
        if (this.editingMessageId()) return '';
        const intent = this.selectedIntent();
        const placeholders = getInputPlaceholders(this.state.config()?.outputLanguage);

        // Map intent to placeholder
        if (intent === GAME_INTENTS.ACTION) return placeholders.ACTION;
        if (intent === GAME_INTENTS.FAST_FORWARD) return placeholders.FAST_FORWARD;
        if (intent === GAME_INTENTS.SYSTEM) return placeholders.SYSTEM;
        if (intent === GAME_INTENTS.SAVE) return placeholders.SAVE;
        if (intent === GAME_INTENTS.CONTINUE) return placeholders.CONTINUE;

        return placeholders.FALLBACK;
    });

    onEnter(event: Event) {
        const kEv = event as KeyboardEvent;
        if (kEv.key === 'Enter' && (kEv.ctrlKey || kEv.metaKey)) {
            kEv.preventDefault();
            this.sendMessage();
        }
    }

    onInteraction() {
        if (!this.userInput()?.trim() && this.selectedIntent() === GAME_INTENTS.ACTION) {
            this.userInput.set('()');
            // Use setTimeout to ensure the value is rendered before setting selection
            setTimeout(() => {
                const el = this.messageInput().nativeElement;
                if (el) {
                    el.setSelectionRange(1, 1);
                    el.focus();
                }
            }, 0);
        }
    }

    onBlur() {
        if (this.userInput()?.trim() === '()') {
            this.userInput.set('');
        }
    }

    async sendMessage() {
        const inputStr = this.userInput().trim();
        const intent = this.selectedIntent();
        console.log('[ChatInput] sendMessage called with intent:', intent);

        // Validation
        if (!inputStr && (intent === GAME_INTENTS.ACTION || intent === GAME_INTENTS.SYSTEM || intent === GAME_INTENTS.SAVE)) return;

        const isSaveIntent = intent === GAME_INTENTS.SAVE;
        if (isSaveIntent) {
            this.state.contextMode.set('full');
        }

        // Handle Rewind & Resend
        const editId = this.editingMessageId();
        if (editId) {
            this.engine.rewindTo(editId);
            this.editingMessageId.set(null);
            this.originalIntentBeforeEdit = null;
        }

        const msgContent = this.userInput();
        console.log('[ChatInput] Calling engine.sendMessage with intent:', intent, 'content:', msgContent.substring(0, 50));
        this.engine.sendMessage(msgContent, { intent });
        console.log('[ChatInput] engine.sendMessage called, intent was:', intent);

        // Reset
        this.userInput.set('');
        if (intent === GAME_INTENTS.CONTINUE || intent === GAME_INTENTS.SAVE) {
            this.selectedIntent.set(GAME_INTENTS.ACTION);
            if (isSaveIntent) {
                this.state.contextMode.set('smart');
            }
        }

        this.messageSent.emit();
    }

    saveProgress() {
        const placeholders = getInputPlaceholders(this.state.config()?.outputLanguage);
        this.userInput.set(placeholders.SAVE);
        this.selectedIntent.set(GAME_INTENTS.SAVE);
        this.focusInput();
    }

    cancelEdit() {
        this.userInput.set('');
        this.editingMessageId.set(null);
        if (this.originalIntentBeforeEdit) {
            this.selectedIntent.set(this.originalIntentBeforeEdit);
            this.originalIntentBeforeEdit = null;
        }
        this.editCancelled.emit();
    }

    openConfigDialog() {
        this.matDialog.open(ChatConfigDialogComponent, {
            width: '100vw',
            height: '100vh',
            maxWidth: '100vw',
            maxHeight: '100vh',
            panelClass: 'fullscreen-dialog'
        });
    }

    openPayloadPreview() {
        const payload = this.engine.getPreviewPayload(this.userInput(), { intent: this.selectedIntent() });
        this.matDialog.open(PayloadDialogComponent, {
            data: payload,
            width: '100vw',
            height: '100vh',
            maxWidth: '100vw',
            maxHeight: '100vh',
            panelClass: 'fullscreen-dialog'
        });
    }

    async exportToMarkdown() {
        const messages = this.state.messages();
        const validIntents = STORY_INTENTS;
        const storyParts = messages
            .filter(m => m.role === 'model' && !m.isRefOnly && (!m.intent || (validIntents as string[]).includes(m.intent)))
            .map(m => m.content);

        const content = storyParts.join('\n').replace(/<possible save point>/gi, '');
        let filename = 'act_export.md';

        for (let i = messages.length - 2; i >= 0; i--) {
            const isSaveOrSystem = messages[i].role === 'user' && (
                messages[i].content.includes(GAME_INTENTS.SAVE) ||
                messages[i].content.includes(GAME_INTENTS.SYSTEM) ||
                messages[i].intent === GAME_INTENTS.SAVE ||
                messages[i].intent === GAME_INTENTS.SYSTEM
            );

            if (isSaveOrSystem) {
                const nextMsg = messages[i + 1];
                if (nextMsg && nextMsg.role === 'model') {
                    const match = nextMsg.content.match(/## Act\.(\d+)/i);
                    if (match) {
                        filename = `act_${match[1]}.md`;
                        break;
                    }
                }
            }
        }

        const isTauri = (window as unknown as TauriWindow).__TAURI_INTERNALS__ !== undefined;

        if (isTauri) {
            try {
                const { save } = await import('@tauri-apps/plugin-dialog');
                const { writeTextFile } = await import('@tauri-apps/plugin-fs');

                const path = await save({
                    defaultPath: filename,
                    filters: [{ name: 'Markdown', extensions: ['md'] }]
                });

                if (path) {
                    await writeTextFile(path, content);
                }
                return;
            } catch (err) {
                console.error('[ChatInputComponent] Tauri native save failed:', err);
            }
        }

        const blob = new Blob([content], { type: 'application/octet-stream' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
        }, 150);
    }

    openReplaceDialog() {
        this.matDialog.open(ChatReplaceDialogComponent, {
            width: '100vw',
            height: '100vh',
            maxWidth: '100vw',
            maxHeight: '100vh',
            panelClass: 'fullscreen-dialog'
        });
    }

    private focusInput() {
        const inputEl = document.querySelector('textarea, input[matInput]') as HTMLElement;
        inputEl?.focus();
    }

    // External API for parent to trigger edit mode
    startEdit(intent: string, content: string) {
        this.originalIntentBeforeEdit = this.selectedIntent();
        this.selectedIntent.set(intent);
        this.userInput.set(content);
        this.focusInput();
    }

    // Stop generation and delete the current generation message pair
    async stopGeneration(): Promise<void> {
        const dialogRef = this.matDialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(
            ConfirmDialogComponent,
            {
                data: {
                    title: this.lang.t('STOP_GENERATION_CONFIRM_TITLE'),
                    message: this.lang.t('STOP_GENERATION_CONFIRM_MSG'),
                    okText: this.lang.t('STOP_GENERATION'),
                    cancelText: this.lang.t('CANCEL')
                },
                width: '400px'
            }
        );

        const confirmed = await firstValueFrom(dialogRef.afterClosed());
        if (!confirmed) return;

        // Stop the generation process
        this.engine.stopGeneration();
    }
}
