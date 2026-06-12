import { Component, effect, inject, signal, computed, viewChild } from '@angular/core';
import { WINDOW } from '@app/core/tokens/window.token';
import { MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatListModule } from '@angular/material/list';
import { MatSelectModule } from '@angular/material/select';
import { MatMenuModule } from '@angular/material/menu';
import { MatDividerModule } from '@angular/material/divider';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { FormsModule } from '@angular/forms';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { HunkListComponent } from '../hunk-list/hunk-list.component';
import { HunkListConfig, HunkSelection } from '../hunk-list/hunk-list.types';
import { FileUpdate } from '@app/core/services/file-update.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { MatSnackBar } from '@angular/material/snack-bar';
import { GAME_INTENTS } from '@app/core/constants/game-intents';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { PostProcessorService } from '@app/core/services/post-processor.service';
import { ALL_PROMPT_TYPES, InjectionService, PromptType } from '@app/core/services/injection.service';
import { LoadingService } from '@app/core/services/loading.service';
import { DialogService } from '@app/core/services/dialog.service';
import { PromptDiffDialogComponent } from '../prompt-diff-dialog/prompt-diff-dialog.component';
import { MatBadgeModule } from '@angular/material/badge';
import { ProfileManagementController } from './profile-management-controller';
import { AppAgentHintDirective } from '@app/core/services/agent-hints/agent-hints.directive';

interface InjectionType {
    id: 'action' | 'continue' | 'fastforward' | 'system' | 'postprocess' | 'system_main' | 'protocol_single' | 'protocol_resolver' | 'protocol_narrator' | 'correction' | 'save_manifest' | 'save_inventory_consistency' | 'save_character_state' | 'save_faction_state' | 'save_character_triage' | 'save_faction_triage';
    label: string;
    icon: string;
    category: 'main' | 'injection' | 'process' | 'save';
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
        ...CORE_MAT,
        MatDialogModule,
        MatListModule,
        MatSelectModule,
        MatMenuModule,
        MatDividerModule,
        MatBadgeModule,
        FormsModule,
        MonacoEditorComponent,
        HunkListComponent,
        TranslatePipe,
        AppAgentHintDirective
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
    hunkListRef = viewChild(HunkListComponent);

    constructor() {
        this.profileMgr.bind({
            hasAnyDirty: () => this.hasAnyDirty(),
            clearDirty: () => this.dirtyState.set(new Map()),
            refreshEditorContent: () => this.refreshAllEditorContent(),
        });
        void this.profileMgr.refreshLegacyProfileIds();

        // Once the patch editor mounts after a "create patch" request, hand the
        // carried selection to it so the new patch opens straight into editing.
        effect(() => {
            const list = this.hunkListRef();
            if (this.pendingCreate() && list) {
                this.pendingCreate.set(false);
                list.createFromSelection();
            }
        });
    }

    readonly injectionTypes = computed((): InjectionType[] => {
        return [
            { id: 'system_main', label: this.i18n.translate('ui.SYSTEM_PROMPT_TITLE'), icon: 'settings', category: 'main' },
            { id: 'protocol_single', label: this.i18n.translate('ui.PROTOCOL_SINGLE_TITLE'), icon: 'description', category: 'main' },
            { id: 'protocol_resolver', label: this.i18n.translate('ui.PROTOCOL_RESOLVER_TITLE'), icon: 'description', category: 'main' },
            { id: 'protocol_narrator', label: this.i18n.translate('ui.PROTOCOL_NARRATOR_TITLE'), icon: 'description', category: 'main' },
            { id: 'system', label: this.i18n.translate(`intent.labels.${GAME_INTENTS.SYSTEM}`), icon: 'psychology', category: 'injection' },
            { id: 'action', label: this.i18n.translate(`intent.labels.${GAME_INTENTS.ACTION}`), icon: 'play_arrow', category: 'injection' },
            { id: 'continue', label: this.i18n.translate(`intent.labels.${GAME_INTENTS.CONTINUE}`), icon: 'arrow_forward', category: 'injection' },
            { id: 'fastforward', label: this.i18n.translate(`intent.labels.${GAME_INTENTS.FAST_FORWARD}`), icon: 'fast_forward', category: 'injection' },
            { id: 'correction', label: this.i18n.translate('ui.CORRECTION_TITLE'), icon: 'rule', category: 'injection' },
            { id: 'postprocess', label: this.i18n.translate('intent.labels.post_process'), icon: 'code', category: 'process' },
            { id: 'save_manifest', label: this.i18n.translate('ui.SAVE_MANIFEST_TITLE'), icon: 'save', category: 'save' },
            { id: 'save_inventory_consistency', label: this.i18n.translate('ui.SAVE_INVENTORY_CONSISTENCY_TITLE'), icon: 'inventory_2', category: 'save' },
            { id: 'save_character_triage', label: this.i18n.translate('ui.SAVE_CHARACTER_TRIAGE_TITLE'), icon: 'filter_alt', category: 'save' },
            { id: 'save_character_state', label: this.i18n.translate('ui.SAVE_CHARACTER_STATE_TITLE'), icon: 'person', category: 'save' },
            { id: 'save_faction_triage', label: this.i18n.translate('ui.SAVE_FACTION_TRIAGE_TITLE'), icon: 'filter_alt', category: 'save' },
            { id: 'save_faction_state', label: this.i18n.translate('ui.SAVE_FACTION_STATE_TITLE'), icon: 'groups', category: 'save' }
        ];
    });

    readonly groupedTypes = computed((): PromptCategory[] => {
        const types = this.injectionTypes();
        return [
            { id: 'main', label: this.i18n.translate('ui.CATEGORY_MAIN'), items: types.filter(t => t.category === 'main') },
            { id: 'injection', label: this.i18n.translate('ui.CATEGORY_INJECTION'), items: types.filter(t => t.category === 'injection') },
            { id: 'process', label: this.i18n.translate('ui.CATEGORY_PROCESS'), items: types.filter(t => t.category === 'process') },
            { id: 'save', label: this.i18n.translate('ui.CATEGORY_SAVE'), items: types.filter(t => t.category === 'save') }
        ];
    });

    activeType = signal<InjectionType['id']>('system_main');

    isSidebarCollapsed = signal(false);
    dirtyState = signal<Map<string, boolean>>(new Map());
    validationResult = signal<{ valid: boolean, error?: string }>({ valid: true });

    // BASE text (not the hunk-applied effective signals) — the editor edits the
    // un-patched prompt; local hunk patches are a separate overlay.
    injectionFiles = computed(() => {
        const base = this.state.promptBaseContent();
        const files = new Map<string, string>();
        for (const id of ALL_PROMPT_TYPES) files.set(id, base.get(id) ?? '');
        return files;
    });

    editorOptions = computed(() => ({
        // Read-only in patch mode: the shared base editor is then a selection
        // surface for creating patches, not an editing surface.
        readOnly: this.profileMgr.isActiveBuiltIn() || this.mode() === 'hunks',
        minimap: { enabled: false },
        wordWrap: 'on' as const,
        lineNumbers: 'on' as const,
        language: this.activeType() === 'postprocess' ? 'javascript' : 'markdown'
    }));

    activeTypeLabel = computed(() => {
        const type = this.injectionTypes().find(t => t.id === this.activeType());
        return type?.label || '';
    });

    // ===== Local hunk patches (Part B) =====
    // The left sidebar switches between the prompt-type list ('types') and the
    // active type's patch editor ('hunks'); the right editor mirrors the switch
    // (editable base vs read-only base→effective inline diff).
    mode = signal<'types' | 'hunks'>('types');
    selection = signal<HunkSelection | null>(null);
    private pendingCreate = signal(false);

    readonly hunkConfig: HunkListConfig = {
        allowCreateFromSelection: true,
        autofixEnable: false,
        dragReorder: false,
    };

    baseForActive = computed(() => this.injection.getContentForType(this.activeType() as PromptType));
    hunksForActive = computed(() => this.injection.getHunks(this.activeType() as PromptType));

    patchCount(type: InjectionType['id']): number {
        return this.injection.getHunks(type as PromptType).length;
    }

    enterHunks(type?: InjectionType['id']): void {
        if (type) this.activeType.set(type);
        this.selection.set(null);
        this.mode.set('hunks');
    }

    exitHunks(): void {
        this.mode.set('types');
        this.selection.set(null);
    }

    onEditorSelection(event: { text: string; startLineNumber: number; endLineNumber: number } | null): void {
        this.selection.set(event ? { text: event.text, startLineNumber: event.startLineNumber } : null);
    }

    async onHunksChange(hunks: FileUpdate[]): Promise<void> {
        await this.injection.setHunks(this.activeType() as PromptType, hunks);
    }

    /**
     * One-click from a base-editor selection: switch to the patch editor (keeping
     * the selection) and let the just-mounted <app-hunk-list> seed + open the new
     * patch via the effect above.
     */
    createPatchFromSelection(): void {
        if (!this.selection()) return;
        this.pendingCreate.set(true);
        this.mode.set('hunks');
    }

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

        this.snackBar.open(this.i18n.translate('ui.SAVE_SUCCESS'), this.i18n.translate('ui.CLOSE'), { duration: 2000 });
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
            this.snackBar.open(this.i18n.translate('ui.SAVE_SUCCESS'), this.i18n.translate('ui.CLOSE'), { duration: 2000 });
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
            const ok = await this.dialogService.confirm(this.i18n.translate('ui.UNSAVED_CHANGES_CONFIRM'));
            if (!ok) return;
        }

        const editor = this.editorRef();
        const currentScript = editor?.getFileContent('postprocess') ?? this.state.postProcessScript();
        const validation = this.postProcessor.validate(currentScript);

        if (!validation.valid) {
            const confirmMsg = this.i18n.translate('ui.POST_PROCESS_INVALID_CONFIRM', { error: validation.error ?? '' });
            const ok = await this.dialogService.confirm(confirmMsg);
            if (!ok) {
                if (this.activeType() !== 'postprocess') this.selectType('postprocess');
                return;
            }
        }

        this.dialogRef.close();
    }
}
