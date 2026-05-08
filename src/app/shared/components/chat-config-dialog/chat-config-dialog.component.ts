import { Component, inject, signal, computed, viewChild } from '@angular/core';
import { WINDOW } from '@app/core/tokens/window.token';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { FormsModule } from '@angular/forms';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { GameStateService } from '@app/core/services/game-state.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { MatSnackBar } from '@angular/material/snack-bar';
import { GAME_INTENTS } from '@app/core/constants/game-intents';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { PostProcessorService } from '@app/core/services/post-processor.service';
import { InjectionService, PromptType } from '@app/core/services/injection.service';
import { LoadingService } from '@app/core/services/loading.service';
import { DialogService } from '@app/core/services/dialog.service';
import { PromptDiffDialogComponent } from '../prompt-diff-dialog/prompt-diff-dialog.component';
import { MatBadgeModule } from '@angular/material/badge';
import { ProfileManagementController } from './profile-management-controller';

interface InjectionType {
    id: 'action' | 'continue' | 'fastforward' | 'system' | 'save' | 'postprocess' | 'system_main' | 'protocol_single' | 'protocol_resolver' | 'protocol_narrator';
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
        MatSelectModule,
        MatMenuModule,
        MatDividerModule,
        MatBadgeModule,
        FormsModule,
        MonacoEditorComponent,
        TranslatePipe
    ],
    templateUrl: './chat-config-dialog.component.html',
    styleUrl: './chat-config-dialog.component.scss',
    providers: [ProfileManagementController]
})
export class ChatConfigDialogComponent {
    private dialogRef = inject(MatDialogRef<ChatConfigDialogComponent>);
    private dialog = inject(MatDialog);
    private snackBar = inject(MatSnackBar);
    private postProcessor = inject(PostProcessorService);
    private injection = inject(InjectionService);
    loading = inject(LoadingService);
    private dialogService = inject(DialogService);
    private readonly win = inject(WINDOW);
    state = inject(GameStateService);
    private appConfig = inject(AppConfigStore);
    private i18n = inject(I18nService);
    profileMgr = inject(ProfileManagementController);

    editorRef = viewChild<MonacoEditorComponent>('editorRef');

    constructor() {
        this.profileMgr.bind({
            hasAnyDirty: () => this.hasAnyDirty(),
            clearDirty: () => this.dirtyState.set(new Map()),
            refreshEditorContent: () => this.refreshAllEditorContent(),
        });
        void this.profileMgr.refreshLegacyProfileIds();
    }

    /** UI strings via i18n; tracked through computeds so locale changes propagate. */
    private t(key: string, params?: Record<string, string | number>): string {
        return this.i18n.translate(key, params);
    }

    readonly injectionTypes = computed((): InjectionType[] => {
        this.i18n.currentLang();
        return [
            { id: 'system_main', label: this.t('ui.SYSTEM_PROMPT_TITLE'), icon: 'settings', category: 'main' },
            { id: 'protocol_single', label: this.t('ui.PROTOCOL_SINGLE_TITLE'), icon: 'description', category: 'main' },
            { id: 'protocol_resolver', label: this.t('ui.PROTOCOL_RESOLVER_TITLE'), icon: 'description', category: 'main' },
            { id: 'protocol_narrator', label: this.t('ui.PROTOCOL_NARRATOR_TITLE'), icon: 'description', category: 'main' },
            { id: 'system', label: this.t(`intent.labels.${GAME_INTENTS.SYSTEM}`), icon: 'psychology', category: 'injection' },
            { id: 'action', label: this.t(`intent.labels.${GAME_INTENTS.ACTION}`), icon: 'play_arrow', category: 'injection' },
            { id: 'continue', label: this.t(`intent.labels.${GAME_INTENTS.CONTINUE}`), icon: 'arrow_forward', category: 'injection' },
            { id: 'save', label: this.t(`intent.labels.${GAME_INTENTS.SAVE}`), icon: 'save', category: 'injection' },
            { id: 'fastforward', label: this.t(`intent.labels.${GAME_INTENTS.FAST_FORWARD}`), icon: 'fast_forward', category: 'injection' },
            { id: 'postprocess', label: this.t('intent.labels.post_process'), icon: 'code', category: 'process' }
        ];
    });

    readonly groupedTypes = computed((): PromptCategory[] => {
        this.i18n.currentLang();
        const types = this.injectionTypes();
        return [
            { id: 'main', label: this.t('ui.CATEGORY_MAIN'), items: types.filter(t => t.category === 'main') },
            { id: 'injection', label: this.t('ui.CATEGORY_INJECTION'), items: types.filter(t => t.category === 'injection') },
            { id: 'process', label: this.t('ui.CATEGORY_PROCESS'), items: types.filter(t => t.category === 'process') }
        ];
    });

    activeType = signal<InjectionType['id']>('system_main');

    isSidebarCollapsed = signal(false);
    dirtyState = signal<Map<string, boolean>>(new Map());
    validationResult = signal<{ valid: boolean, error?: string }>({ valid: true });

    injectionFiles = computed(() => {
        const files = new Map<string, string>();
        files.set('action', this.state.dynamicActionInjection());
        files.set('continue', this.state.dynamicContinueInjection());
        files.set('fastforward', this.state.dynamicFastforwardInjection());
        files.set('system', this.state.dynamicSystemInjection());
        files.set('save', this.state.dynamicSaveInjection());
        files.set('system_main', this.state.dynamicSystemMainInjection());
        files.set('protocol_single', this.state.dynamicProtocolSingleInjection());
        files.set('protocol_resolver', this.state.dynamicProtocolResolverInjection());
        files.set('protocol_narrator', this.state.dynamicProtocolNarratorInjection());
        files.set('postprocess', this.state.postProcessScript());
        return files;
    });

    editorOptions = computed(() => ({
        readOnly: this.profileMgr.isActiveBuiltIn(),
        minimap: { enabled: false },
        wordWrap: 'on' as const,
        lineNumbers: 'on' as const,
        language: this.activeType() === 'postprocess' ? 'javascript' : 'markdown'
    }));

    activeTypeLabel = computed(() => {
        const type = this.injectionTypes().find(t => t.id === this.activeType());
        return type?.label || '';
    });

    getIsDirty(type: string): boolean {
        return !!this.dirtyState().get(type);
    }

    selectType(type: InjectionType['id']): void {
        this.activeType.set(type);

        if (type === 'postprocess') {
            const content = this.getContentForType('postprocess');
            this.validationResult.set(this.postProcessor.validate(content));
        } else {
            this.validationResult.set({ valid: true });
        }

        if (this.win.innerWidth < 768) {
            this.isSidebarCollapsed.set(true);
        }
    }

    hasAnyDirty = computed(() => {
        return Array.from(this.dirtyState().values()).some(isDirty => isDirty);
    });

    async saveCurrent(): Promise<void> {
        const editor = this.editorRef();
        if (!editor) return;

        const type = this.activeType();
        const content = editor.getFileContent(type);
        if (content === undefined) return;

        await this.injection.saveToService(type as PromptType, content);

        this.dirtyState.update(map => {
            const newMap = new Map(map);
            newMap.set(type, false);
            return newMap;
        });

        if (type === 'system_main') {
            await this.profileMgr.refreshLegacyProfileIds();
        }

        this.snackBar.open(this.t('ui.SAVE_SUCCESS'), this.t('ui.CLOSE'), { duration: 2000 });
    }

    async saveAll(): Promise<void> {
        const editor = this.editorRef();
        if (!editor) return;

        const dirtyMap = this.dirtyState();
        let savedCount = 0;
        const systemMainSaved = !!dirtyMap.get('system_main');

        for (const [type, isDirty] of dirtyMap.entries()) {
            if (!isDirty) continue;

            const content = editor.getFileContent(type);
            if (content === undefined) continue;

            await this.injection.saveToService(type as PromptType, content);
            savedCount++;
        }

        if (savedCount > 0) {
            this.dirtyState.set(new Map());
            if (systemMainSaved) {
                await this.profileMgr.refreshLegacyProfileIds();
            }
            this.snackBar.open(this.t('ui.SAVE_SUCCESS'), this.t('ui.CLOSE'), { duration: 2000 });
        }
    }

    onValueChange(content: string): void {
        const type = this.activeType();
        const originalContent = this.getContentForType(type);
        const isDirty = content !== originalContent;

        if (this.dirtyState().get(type) !== isDirty) {
            this.dirtyState.update(map => {
                const newMap = new Map(map);
                newMap.set(type, isDirty);
                return newMap;
            });
        }

        if (type === 'postprocess') {
            const validation = this.postProcessor.validate(content);
            this.validationResult.set(validation);
        }
    }

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

            const editor = this.editorRef();
            if (editor) {
                const content = this.getContentForType(type);
                editor.updateFileContent(type, content);
            }
        } else if (result === 'ignore') {
            await this.injection.acknowledgeUpdate(type, false);
        }
    }

    private getContentForType(type: InjectionType['id']): string {
        return this.injection.getContentForType(type as PromptType);
    }

    private refreshAllEditorContent(): void {
        const editor = this.editorRef();
        if (!editor) return;
        for (const type of this.injectionTypes()) {
            editor.updateFileContent(type.id, this.getContentForType(type.id));
        }
    }

    toggleSidebar(): void {
        this.isSidebarCollapsed.update(v => !v);
    }

    async close(): Promise<void> {
        const dirtyTypes = Array.from(this.dirtyState().entries())
            .filter((entry) => entry[1])
            .map((entry) => entry[0]);

        if (dirtyTypes.length > 0) {
            const ok = await this.dialogService.confirm(this.t('ui.UNSAVED_CHANGES_CONFIRM'));
            if (!ok) return;
        }

        const editor = this.editorRef();
        const currentScript = editor?.getFileContent('postprocess') ?? this.state.postProcessScript();
        const validation = this.postProcessor.validate(currentScript);

        if (!validation.valid) {
            const confirmMsg = this.t('ui.POST_PROCESS_INVALID_CONFIRM', { error: validation.error ?? '' });
            const ok = await this.dialogService.confirm(confirmMsg);
            if (!ok) {
                if (this.activeType() !== 'postprocess') this.selectType('postprocess');
                return;
            }
        }

        this.dialogRef.close();
    }
}
