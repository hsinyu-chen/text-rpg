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
import { MatSnackBar } from '@angular/material/snack-bar';

/** Injection type definition */
interface InjectionType {
    id: 'action' | 'continue' | 'fastforward' | 'system' | 'save';
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
    engine = inject(GameEngineService);

    // Editor reference
    editorRef = viewChild<MonacoEditorComponent>('editorRef');

    // Injection types for sidebar
    readonly injectionTypes: InjectionType[] = [
        { id: 'action', label: '行動意圖', icon: 'play_arrow' },
        { id: 'continue', label: '繼續', icon: 'arrow_forward' },
        { id: 'fastforward', label: '快轉', icon: 'fast_forward' },
        { id: 'system', label: '系統指令', icon: 'settings' },
        { id: 'save', label: '存檔指令', icon: 'save' }
    ];

    // Active injection type
    activeType = signal<InjectionType['id']>('action');

    // Sidebar collapsed state (mobile)
    isSidebarCollapsed = signal(false);

    // Build files map for Monaco multi-model mode
    injectionFiles = computed(() => {
        const files = new Map<string, string>();
        files.set('action', this.engine.dynamicActionInjection());
        files.set('continue', this.engine.dynamicContinueInjection());
        files.set('fastforward', this.engine.dynamicFastforwardInjection());
        files.set('system', this.engine.dynamicSystemInjection());
        files.set('save', this.engine.dynamicSaveInjection());
        return files;
    });

    // Monaco editor options
    editorOptions = signal({
        readOnly: false,
        minimap: { enabled: false },
        wordWrap: 'on' as const,
        lineNumbers: 'on' as const
    });

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
        const type = this.injectionTypes.find(t => t.id === this.activeType());
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
                this.engine.dynamicActionInjection.set(content);
                break;
            case 'continue':
                this.engine.dynamicContinueInjection.set(content);
                break;
            case 'fastforward':
                this.engine.dynamicFastforwardInjection.set(content);
                break;
            case 'system':
                this.engine.dynamicSystemInjection.set(content);
                break;
            case 'save':
                this.engine.dynamicSaveInjection.set(content);
                break;
        }
    }

    /** Handle value change from Monaco */
    onValueChange(content: string): void {
        const type = this.activeType();
        switch (type) {
            case 'action':
                this.engine.dynamicActionInjection.set(content);
                break;
            case 'continue':
                this.engine.dynamicContinueInjection.set(content);
                break;
            case 'fastforward':
                this.engine.dynamicFastforwardInjection.set(content);
                break;
            case 'system':
                this.engine.dynamicSystemInjection.set(content);
                break;
            case 'save':
                this.engine.dynamicSaveInjection.set(content);
                break;
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

        this.snackBar.open(`已重置「${this.activeTypeLabel()}」`, 'Close', { duration: 2000 });
    }

    /** Reset all injection types to defaults */
    async resetAll(): Promise<void> {
        await this.engine.resetInjectionDefaults('all');

        // Refresh all editor models
        const editor = this.editorRef();
        if (editor) {
            for (const type of this.injectionTypes) {
                const content = this.getContentForType(type.id);
                editor.updateFileContent(type.id, content);
            }
        }

        this.snackBar.open('已重置所有動態提示', 'Close', { duration: 2000 });
    }

    /** Get content for a specific type */
    private getContentForType(type: InjectionType['id']): string {
        switch (type) {
            case 'action': return this.engine.dynamicActionInjection();
            case 'continue': return this.engine.dynamicContinueInjection();
            case 'fastforward': return this.engine.dynamicFastforwardInjection();
            case 'system': return this.engine.dynamicSystemInjection();
            case 'save': return this.engine.dynamicSaveInjection();
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
