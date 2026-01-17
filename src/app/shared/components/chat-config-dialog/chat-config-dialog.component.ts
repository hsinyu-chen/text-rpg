import { Component, inject, signal, computed, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';
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
import { InjectionService, PromptType } from '../../../core/services/injection.service';
import { PromptDiffDialogComponent } from '../prompt-diff-dialog/prompt-diff-dialog.component';
import { MatBadgeModule } from '@angular/material/badge';

/** Injection type definition */
interface InjectionType {
    id: 'action' | 'continue' | 'fastforward' | 'system' | 'save' | 'postprocess' | 'system_main';
    label: string;
    icon: string;
    category: 'main' | 'injection' | 'process';
}

interface PromptCategory {
    id: string;
    label: string;
    items: InjectionType[];
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
        MatBadgeModule,
        FormsModule,
        MonacoEditorComponent
    ],
    templateUrl: './chat-config-dialog.component.html',
    styleUrl: './chat-config-dialog.component.scss'
})
export class ChatConfigDialogComponent {
    private dialogRef = inject(MatDialogRef<ChatConfigDialogComponent>);
    private dialog = inject(MatDialog);
    private snackBar = inject(MatSnackBar);
    private postProcessor = inject(PostProcessorService);
    private injection = inject(InjectionService);
    engine = inject(GameEngineService);
    state = inject(GameStateService);

    // Editor reference
    editorRef = viewChild<MonacoEditorComponent>('editorRef');

    ui = computed(() => {
        const lang = this.state.config()?.outputLanguage || 'default';
        return getUIStrings(lang);
    });

    // Injection types for sidebar
    readonly injectionTypes = computed((): InjectionType[] => {
        const labels = getIntentLabels(this.state.config()?.outputLanguage);
        const ui = this.ui();
        return [
            { id: 'system_main', label: ui.SYSTEM_PROMPT_TITLE || 'Main System Prompt', icon: 'settings', category: 'main' },
            { id: 'system', label: labels.SYSTEM, icon: 'psychology', category: 'injection' },
            { id: 'action', label: labels.ACTION, icon: 'play_arrow', category: 'injection' },
            { id: 'continue', label: labels.CONTINUE, icon: 'arrow_forward', category: 'injection' },
            { id: 'save', label: labels.SAVE, icon: 'save', category: 'injection' },
            { id: 'fastforward', label: labels.FAST_FORWARD, icon: 'fast_forward', category: 'injection' },
            { id: 'postprocess', label: labels.POST_PROCESS, icon: 'code', category: 'process' }
        ];
    });

    // Grouped types for template rendering
    readonly groupedTypes = computed((): PromptCategory[] => {
        const types = this.injectionTypes();
        const ui = this.ui();

        return [
            { id: 'main', label: ui.CATEGORY_MAIN, items: types.filter(t => t.category === 'main') },
            { id: 'injection', label: ui.CATEGORY_INJECTION, items: types.filter(t => t.category === 'injection') },
            { id: 'process', label: ui.CATEGORY_PROCESS, items: types.filter(t => t.category === 'process') }
        ];
    });

    // Active injection type
    activeType = signal<InjectionType['id']>('system_main');

    // Sidebar collapsed state (mobile)
    isSidebarCollapsed = signal(false);

    // Track dirty state (unsaved changes) per type
    dirtyState = signal<Map<string, boolean>>(new Map());

    // Build files map for Monaco multi-model mode
    injectionFiles = computed(() => {
        const files = new Map<string, string>();
        files.set('action', this.state.dynamicActionInjection());
        files.set('continue', this.state.dynamicContinueInjection());
        files.set('fastforward', this.state.dynamicFastforwardInjection());
        files.set('system', this.state.dynamicSystemInjection());
        files.set('save', this.state.dynamicSaveInjection());
        files.set('system_main', this.state.dynamicSystemMainInjection());
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

    activeTypeLabel = computed(() => {
        const type = this.injectionTypes().find(t => t.id === this.activeType());
        return type?.label || '';
    });

    /** Check if a type has unsaved changes */
    getIsDirty(type: string): boolean {
        return !!this.dirtyState().get(type);
    }

    /** Select an injection type */
    selectType(type: InjectionType['id']): void {
        this.activeType.set(type);

        // Collapse sidebar on mobile
        if (window.innerWidth < 768) {
            this.isSidebarCollapsed.set(true);
        }
    }

    /** Check if any file has unsaved changes */
    hasAnyDirty = computed(() => {
        return Array.from(this.dirtyState().values()).some(isDirty => isDirty);
    });

    /** Save only the current active file */
    async saveCurrent(): Promise<void> {
        const editor = this.editorRef();
        if (!editor) return;

        const type = this.activeType();
        const content = editor.getFileContent(type);
        if (content === undefined) return;

        await this.injection.saveToService(type as PromptType, content);

        // Clear dirty flag for this specific type
        this.dirtyState.update(map => {
            const newMap = new Map(map);
            newMap.set(type, false);
            return newMap;
        });

        this.snackBar.open(this.ui().SAVE_SUCCESS, this.ui().CLOSE, { duration: 2000 });
    }

    /** Save all modified content to engine signals and storage */
    async saveAll(): Promise<void> {
        const editor = this.editorRef();
        if (!editor) return;

        const dirtyMap = this.dirtyState();
        let savedCount = 0;

        // Iterate through all tracked files and save those that are dirty
        for (const [type, isDirty] of dirtyMap.entries()) {
            if (!isDirty) continue;

            const content = editor.getFileContent(type);
            if (content === undefined) continue;

            await this.injection.saveToService(type as PromptType, content);
            savedCount++;
        }

        if (savedCount > 0) {
            // Reset all dirty flags since we saved everything
            this.dirtyState.set(new Map());
            this.snackBar.open(this.ui().SAVE_SUCCESS, this.ui().CLOSE, { duration: 2000 });
        }
    }

    /** Handle value change from Monaco */
    onValueChange(content: string): void {
        const type = this.activeType();
        const originalContent = this.getContentForType(type);

        // Simple dirty check: if content is different from original in GameStateService
        const isDirty = content !== originalContent;

        if (this.dirtyState().get(type) !== isDirty) {
            this.dirtyState.update(map => {
                const newMap = new Map(map);
                newMap.set(type, isDirty);
                return newMap;
            });
        }
    }

    /** Open the prompt update diff dialog */
    async openPromptUpdateDialog(type: InjectionType['id']): Promise<void> {
        const status = this.state.promptUpdateStatus().get(type);
        if (!status) return;

        const currentContent = this.getContentForType(type);
        const typeLabel = this.injectionTypes().find(t => t.id === type)?.label || type;

        const dialogRef = this.dialog.open(PromptDiffDialogComponent, {
            data: {
                type,
                localContent: currentContent,
                remoteContent: status.serverContent,
                label: typeLabel
            },
            width: '95vw',
            height: '95vh',
            maxWidth: '1400px',
            maxHeight: '1000px',
            panelClass: 'custom-diff-dialog'
        });

        const result = await dialogRef.afterClosed().toPromise();
        if (result === 'update') {
            await this.injection.acknowledgeUpdate(type, true);

            // Refresh editor content
            const editor = this.editorRef();
            if (editor) {
                const content = this.getContentForType(type);
                editor.updateFileContent(type, content);
            }
        } else if (result === 'ignore') {
            await this.injection.acknowledgeUpdate(type, false);
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
        return this.injection.getContentForType(type as PromptType);
    }

    /** Toggle sidebar visibility */
    toggleSidebar(): void {
        this.isSidebarCollapsed.update(v => !v);
    }

    /** Close the dialog */
    close(): void {
        // Check for unsaved changes across all types
        const dirtyTypes = Array.from(this.dirtyState().entries())
            .filter((entry) => entry[1]) // entry[1] is isDirty
            .map((entry) => entry[0]);   // entry[0] is type

        if (dirtyTypes.length > 0) {
            const lang = this.state.config()?.outputLanguage || 'default';
            const confirmMsg = lang === 'zh-TW'
                ? '尚有未儲存的變更，確定要關閉嗎？'
                : 'There are unsaved changes. Are you sure you want to close?';

            if (!confirm(confirmMsg)) {
                return;
            }
        }

        // Validate postprocess script before closing
        const script = this.state.postProcessScript();
        const validation = this.postProcessor.validate(script);

        if (!validation.valid) {
            const lang = this.state.config()?.outputLanguage || 'default';

            // Show confirm dialog
            const confirmMsg = lang === 'zh-TW'
                ? `後處理腳本有錯誤：${validation.error}\n\n確定要關閉嗎？腳本將保持無效狀態。`
                : `Post-process script error: ${validation.error}\n\nClose anyway? Script will remain invalid.`;

            if (!confirm(confirmMsg)) {
                return; // User cancelled, don't close
            }
        }

        this.dialogRef.close();
    }
}
