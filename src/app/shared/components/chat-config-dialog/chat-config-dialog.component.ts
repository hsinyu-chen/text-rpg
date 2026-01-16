import { Component, inject, signal, computed, viewChild, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { GameEngineService } from '../../../core/services/game-engine.service';
import { GameStateService } from '../../../core/services/game-state.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { getUIStrings, getIntentLabels } from '../../../core/constants/engine-protocol';
import { PostProcessorService } from '../../../core/services/post-processor.service';

/** Injection type definition */
interface InjectionType {
    id: 'action' | 'continue' | 'fastforward' | 'system' | 'save' | 'postprocess';
    label: string;
    icon: string;
}

@Component({
    selector: 'app-chat-config-dialog',
    standalone: true,
    imports: [
        CommonModule,
        MatDialogModule,
        MatButtonModule,
        MatIconModule,
        MatListModule,
        MatTooltipModule,
        FormsModule,
        MonacoEditorComponent
    ],
    templateUrl: './chat-config-dialog.component.html',
    styleUrl: './chat-config-dialog.component.scss'
})
export class ChatConfigDialogComponent {
    private dialogRef = inject(MatDialogRef<ChatConfigDialogComponent>);
    private snackBar = inject(MatSnackBar);
    private postProcessor = inject(PostProcessorService);
    engine = inject(GameEngineService);
    state = inject(GameStateService);

    // Editor reference
    editorRef = viewChild<MonacoEditorComponent>('editorRef');

    // Injection types for sidebar
    readonly injectionTypes = computed((): InjectionType[] => {
        const labels = getIntentLabels(this.state.config()?.outputLanguage);
        return [
            { id: 'action', label: labels.ACTION, icon: 'play_arrow' },
            { id: 'continue', label: labels.CONTINUE, icon: 'arrow_forward' },
            { id: 'fastforward', label: labels.FAST_FORWARD, icon: 'fast_forward' },
            { id: 'system', label: labels.SYSTEM, icon: 'settings' },
            { id: 'save', label: labels.SAVE, icon: 'save' },
            { id: 'postprocess', label: labels.POST_PROCESS, icon: 'code' }
        ];
    });

    // Active injection type
    activeType = signal<InjectionType['id']>('action');

    ui = computed(() => {
        const lang = this.state.config()?.outputLanguage || 'default';
        return getUIStrings(lang);
    });

    // Sidebar collapsed state (mobile)
    isSidebarCollapsed = signal(false);

    // Build files map for Monaco multi-model mode
    injectionFiles = computed(() => {
        const files = new Map<string, string>();
        files.set('action', this.state.dynamicActionInjection());
        files.set('continue', this.state.dynamicContinueInjection());
        files.set('fastforward', this.state.dynamicFastforwardInjection());
        files.set('system', this.state.dynamicSystemInjection());
        files.set('save', this.state.dynamicSaveInjection());
        files.set('postprocess', this.state.postProcessScript());
        return files;
    });

    // Monaco editor options - language changes based on active type
    editorOptions = computed(() => ({
        readOnly: false,
        minimap: { enabled: false },
        wordWrap: 'on' as const,
        lineNumbers: 'on' as const,
        language: this.activeType() === 'postprocess' ? 'javascript' : 'markdown'
    }));

    constructor() {
        // Sync Monaco changes back to engine signals
        effect(() => {
            const editor = this.editorRef();
            if (!editor) return;

            // This effect will re-run when activeType changes
            const type = this.activeType();
            void type; // Trigger reactivity
        });
    }

    /** Get current active type label */
    activeTypeLabel = computed(() => {
        const type = this.injectionTypes().find(t => t.id === this.activeType());
        return type?.label || '';
    });

    /** Select an injection type */
    selectType(type: InjectionType['id']): void {
        // Save current content before switching
        this.syncCurrentContent();
        this.activeType.set(type);

        // Collapse sidebar on mobile
        if (window.innerWidth < 768) {
            this.isSidebarCollapsed.set(true);
        }
    }

    /** Sync current editor content to engine signal */
    private syncCurrentContent(): void {
        const editor = this.editorRef();
        if (!editor) return;

        const type = this.activeType();
        const content = editor.getFileContent(type);
        if (content === undefined) return;

        switch (type) {
            case 'action':
                this.state.dynamicActionInjection.set(content);
                break;
            case 'continue':
                this.state.dynamicContinueInjection.set(content);
                break;
            case 'fastforward':
                this.state.dynamicFastforwardInjection.set(content);
                break;
            case 'system':
                this.state.dynamicSystemInjection.set(content);
                break;
            case 'save':
                this.state.dynamicSaveInjection.set(content);
                break;
            case 'postprocess':
                this.state.postProcessScript.set(content);
                break;
        }
    }

    /** Handle value change from Monaco */
    onValueChange(content: string): void {
        const type = this.activeType();
        switch (type) {
            case 'action':
                this.state.dynamicActionInjection.set(content);
                break;
            case 'continue':
                this.state.dynamicContinueInjection.set(content);
                break;
            case 'fastforward':
                this.state.dynamicFastforwardInjection.set(content);
                break;
            case 'system':
                this.state.dynamicSystemInjection.set(content);
                break;
            case 'save':
                this.state.dynamicSaveInjection.set(content);
                break;
            case 'postprocess': {
                // Validate before saving
                const validation = this.postProcessor.validate(content);
                if (!validation.valid) {
                    const lang = this.state.config()?.outputLanguage || 'default';
                    const ui = getUIStrings(lang);
                    this.snackBar.open(
                        ui.POST_PROCESS_ERROR.replace('{error}', validation.error || 'Unknown error'),
                        ui.CLOSE,
                        { duration: 5000, panelClass: 'error-snackbar' }
                    );
                }
                this.state.postProcessScript.set(content);
                break;
            }
        }
    }

    /** Reset current injection type to default */
    async resetCurrent(): Promise<void> {
        const type = this.activeType();
        await this.engine.resetInjectionDefaults(type);

        // Refresh editor content
        const editor = this.editorRef();
        if (editor) {
            const content = this.getContentForType(type);
            editor.updateFileContent(type, content);
        }

        this.syncCurrentContent();

        const lang = this.state.config()?.outputLanguage || 'default';
        const ui = getUIStrings(lang);
        this.snackBar.open(ui.PROMPT_RESET_SUCCESS.replace('{type}', this.activeTypeLabel()), ui.CLOSE, { duration: 2000 });
    }

    /** Reset all injection types to defaults */
    async resetAll(): Promise<void> {
        await this.engine.resetInjectionDefaults('all');

        // Refresh all editor models
        const editor = this.editorRef();
        if (editor) {
            for (const type of this.injectionTypes()) {
                const content = this.getContentForType(type.id);
                editor.updateFileContent(type.id, content);
            }
        }

        const lang = this.state.config()?.outputLanguage || 'default';
        const ui = getUIStrings(lang);
        this.snackBar.open(ui.ALL_PROMPTS_RESET_SUCCESS, ui.CLOSE, { duration: 2000 });
    }

    /** Get content for a specific type */
    private getContentForType(type: InjectionType['id']): string {
        switch (type) {
            case 'action': return this.state.dynamicActionInjection();
            case 'continue': return this.state.dynamicContinueInjection();
            case 'fastforward': return this.state.dynamicFastforwardInjection();
            case 'system': return this.state.dynamicSystemInjection();
            case 'save': return this.state.dynamicSaveInjection();
            case 'postprocess': return this.state.postProcessScript();
        }
    }

    /** Toggle sidebar visibility */
    toggleSidebar(): void {
        this.isSidebarCollapsed.update(v => !v);
    }

    /** Close the dialog */
    close(): void {
        // Sync final content before closing
        this.syncCurrentContent();
        this.dialogRef.close();
    }
}
