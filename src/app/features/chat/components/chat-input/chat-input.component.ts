import { Component, model, ChangeDetectionStrategy, inject, output, viewChild, ElementRef, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DOCUMENT } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatMenuModule } from '@angular/material/menu';
import { MatBadgeModule } from '@angular/material/badge';
import { TextFieldModule } from '@angular/cdk/text-field';
import { CORE_MAT, FORM_MAT } from '@app/shared/material/material-groups';
import { GAME_INTENTS, STORY_INTENTS } from '@app/core/constants/game-intents';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { ConfigService } from '@app/core/services/config.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { SessionService } from '@app/core/services/session.service';
import { MatDialog } from '@angular/material/dialog';
import { PayloadDialogComponent } from '@app/shared/components/payload-dialog/payload-dialog.component';
import { ChatConfigDialogComponent } from '@app/shared/components/chat-config-dialog/chat-config-dialog.component';
import { ChatReplaceDialogComponent } from '../chat-replace-dialog/chat-replace-dialog.component';
import { ConfirmDialogComponent, ConfirmDialogData } from '@app/shared/components/confirm-dialog/confirm-dialog.component';
import { TauriWindow } from '@app/core/models/types';
import { LanguageService } from '@app/core/services/language.service';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { PromptProfileRegistryService } from '@app/core/services/prompt-profile-registry.service';
import { SystemStatusService } from '@app/core/services/system-status.service';
import { getProfileDisplayName } from '@app/core/constants/prompt-profiles';
import { ContextUsageBarComponent } from '@app/shared/components/context-usage-bar/context-usage-bar.component';

@Component({
    selector: 'app-chat-input',
    standalone: true,
    imports: [
        ...CORE_MAT,
        ...FORM_MAT,
        MatMenuModule,
        MatBadgeModule,
        FormsModule,
        TextFieldModule,
        ContextUsageBarComponent,
        TranslatePipe
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
    sys = inject(SystemStatusService);
    private i18n = inject(I18nService);
    private profileRegistry = inject(PromptProfileRegistryService);
    private config = inject(ConfigService);
    private appConfig = inject(AppConfigStore);
    private matDialog = inject(MatDialog);
    private readonly doc = inject(DOCUMENT);

    activeProfileName = computed(() => {
        const id = this.state.activePromptProfile();
        const profile = this.profileRegistry.get(id);
        if (!profile) return id;
        return getProfileDisplayName(profile, k => this.i18n.translate(k));
    });

    // Two-call is the only engine mode that consumes userIdealOutcome,
    // so the field is shown conditionally on this flag.
    isTwoCall = computed(() => this.appConfig.engineMode() === 'two-call');
    engineModeLabel = computed(() =>
        this.i18n.translate(this.isTwoCall() ? 'ui.ENGINE_MODE_TWO_CALL' : 'ui.ENGINE_MODE_SINGLE'));

    hasActiveSession = computed(() => !!this.session.currentBookId());

    // Queries
    messageInput = viewChild.required<ElementRef<HTMLTextAreaElement>>('messageInput');

    // Inputs/Models
    userInput = model<string>('');
    userIdealOutcome = model<string>('');
    selectedIntent = model<string>(GAME_INTENTS.ACTION);
    editingMessageId = model<string | null>(null);
    /** Toggled via the ideal-outcome chip; collapsed by default on both PC and mobile to keep the row visually quiet until the user opts in. */
    idealOutcomeExpanded = model<boolean>(false);

    // Outputs
    messageSent = output<void>();
    editCancelled = output<void>();
    toggleSidebar = output<void>();

    // Local State
    intents = Object.values(GAME_INTENTS);
    private originalIntentBeforeEdit: string | null = null;

    getIntentLabel(intent: string): string {
        const key = `intent.labels.${intent}`;
        const translated = this.i18n.translate(key);
        // Custom user intents (e.g. from a non-default prompt profile) have no
        // dictionary entry — fall back to the raw value so the chip doesn't
        // render the dotted key as a string.
        return translated === key ? intent : translated;
    }

    getIntentDescription(intent: string): string {
        const key = `intent.descriptions.${intent}`;
        const translated = this.i18n.translate(key);
        return translated === key ? '' : translated;
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
        const known = (Object.values(GAME_INTENTS) as string[]).includes(intent);
        return this.i18n.translate(known ? `placeholder.${intent}` : 'placeholder.fallback');
    });

    onEnter(event: Event) {
        const kEv = event as KeyboardEvent;
        if (kEv.key === 'Enter' && (kEv.ctrlKey || kEv.metaKey)) {
            kEv.preventDefault();
            void this.sendMessage();
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

        // Handle Rewind & Resend — await so the rewind's book save completes
        // before the new sendMessage's phase 1 pushes a user message.
        const editId = this.editingMessageId();
        if (editId) {
            await this.engine.rewindTo(editId);
            this.editingMessageId.set(null);
            this.originalIntentBeforeEdit = null;
        }

        const msgContent = this.userInput();
        const idealOutcome = this.isTwoCall() && (STORY_INTENTS as string[]).includes(intent)
            ? this.userIdealOutcome().trim() || undefined
            : undefined;
        console.log('[ChatInput] Calling engine.sendMessage with intent:', intent, 'content:', msgContent.substring(0, 50));
        void this.engine.sendMessage(msgContent, { intent, userIdealOutcome: idealOutcome });
        console.log('[ChatInput] engine.sendMessage called, intent was:', intent);

        // Reset
        this.userInput.set('');
        this.userIdealOutcome.set('');
        if (intent === GAME_INTENTS.CONTINUE || intent === GAME_INTENTS.SAVE) {
            this.selectedIntent.set(GAME_INTENTS.ACTION);
            if (isSaveIntent) {
                this.state.contextMode.set('smart');
            }
        }

        this.messageSent.emit();
    }

    async toggleEngineMode(): Promise<void> {
        const next: 'single' | 'two-call' = this.appConfig.engineMode() === 'two-call' ? 'single' : 'two-call';
        await this.config.saveConfig({ engineMode: next });
    }

    toggleIdealOutcome() {
        this.idealOutcomeExpanded.update(v => !v);
    }

    saveProgress() {
        this.userInput.set(this.i18n.translate('placeholder.save'));
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
        const url = URL.createObjectURL(blob);
        const a = this.doc.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        this.doc.body.appendChild(a);
        a.click();

        setTimeout(() => {
            URL.revokeObjectURL(url);
            this.doc.body.removeChild(a);
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
        this.messageInput()?.nativeElement.focus();
    }

    // External API for parent to trigger edit mode
    startEdit(intent: string, content: string, idealOutcome?: string) {
        this.originalIntentBeforeEdit = this.selectedIntent();
        this.selectedIntent.set(intent);
        this.userInput.set(content);
        // Rehydrate the user-supplied ideal_outcome so an edit-resend keeps
        // the constraint instead of silently dropping it (which would put the
        // resolver back into full-inference mode for that turn).
        this.userIdealOutcome.set(idealOutcome ?? '');
        if (idealOutcome) this.idealOutcomeExpanded.set(true);
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
