import { Component, inject, signal, computed, viewChild } from '@angular/core';
import { WINDOW } from '../../../core/tokens/window.token';
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
import { GameStateService } from '../../../core/services/game-state.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { getUIStrings, getIntentLabels } from '../../../core/constants/engine-protocol';
import { PostProcessorService } from '../../../core/services/post-processor.service';
import { InjectionService, PromptType } from '../../../core/services/injection.service';
import { PromptProfileRegistryService } from '../../../core/services/prompt-profile-registry.service';
import { SyncService } from '../../../core/services/sync/sync.service';
import { DiskProfileSyncService } from '../../../core/services/sync/disk-profile-sync.service';
import { LoadingService } from '../../../core/services/loading.service';
import { DialogService } from '../../../core/services/dialog.service';
import { PromptDiffDialogComponent } from '../prompt-diff-dialog/prompt-diff-dialog.component';
import { MatBadgeModule } from '@angular/material/badge';
import { DEFAULT_PROFILE_ID, PromptProfile, getProfileDisplayName } from '../../../core/constants/prompt-profiles';

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
        MatSelectModule,
        MatMenuModule,
        MatDividerModule,
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
    private registry = inject(PromptProfileRegistryService);
    private sync = inject(SyncService);
    private diskSync = inject(DiskProfileSyncService);
    loading = inject(LoadingService);
    private dialogService = inject(DialogService);
    private readonly win = inject(WINDOW);
    state = inject(GameStateService);

    editorRef = viewChild<MonacoEditorComponent>('editorRef');

    ui = computed(() => {
        const lang = this.state.config()?.outputLanguage || 'default';
        return getUIStrings(lang);
    });

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

    readonly groupedTypes = computed((): PromptCategory[] => {
        const types = this.injectionTypes();
        const ui = this.ui();
        return [
            { id: 'main', label: ui.CATEGORY_MAIN, items: types.filter(t => t.category === 'main') },
            { id: 'injection', label: ui.CATEGORY_INJECTION, items: types.filter(t => t.category === 'injection') },
            { id: 'process', label: ui.CATEGORY_PROCESS, items: types.filter(t => t.category === 'process') }
        ];
    });

    activeType = signal<InjectionType['id']>('system_main');

    builtInProfiles = computed(() => this.registry.builtInProfiles());
    userProfiles = computed(() => this.registry.userProfiles());
    activeProfileId = computed(() => this.state.activePromptProfile());
    activeProfile = computed(() => this.registry.get(this.activeProfileId()));
    isActiveBuiltIn = computed(() => this.activeProfile()?.isBuiltIn ?? false);
    isSwitchingProfile = signal(false);

    getProfileLabel(profile: PromptProfile): string {
        return getProfileDisplayName(profile, this.ui() as unknown as Record<string, string>);
    }

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
        files.set('postprocess', this.state.postProcessScript());
        return files;
    });

    editorOptions = computed(() => ({
        readOnly: this.isActiveBuiltIn(),
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

        this.snackBar.open(this.ui().SAVE_SUCCESS, this.ui().CLOSE, { duration: 2000 });
    }

    async saveAll(): Promise<void> {
        const editor = this.editorRef();
        if (!editor) return;

        const dirtyMap = this.dirtyState();
        let savedCount = 0;

        for (const [type, isDirty] of dirtyMap.entries()) {
            if (!isDirty) continue;

            const content = editor.getFileContent(type);
            if (content === undefined) continue;

            await this.injection.saveToService(type as PromptType, content);
            savedCount++;
        }

        if (savedCount > 0) {
            this.dirtyState.set(new Map());
            this.snackBar.open(this.ui().SAVE_SUCCESS, this.ui().CLOSE, { duration: 2000 });
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

    async switchProfile(newProfileId: string): Promise<void> {
        if (newProfileId === this.activeProfileId()) return;

        if (this.hasAnyDirty()) {
            const ok = await this.dialogService.confirm(this.ui().PROFILE_SWITCH_DISCARD_CONFIRM);
            if (!ok) return;
        }

        this.isSwitchingProfile.set(true);
        try {
            await this.injection.switchProfile(newProfileId);
            this.refreshAllEditorContent();
            this.dirtyState.set(new Map());
        } finally {
            this.isSwitchingProfile.set(false);
        }
    }

    async cloneActive(): Promise<void> {
        const active = this.activeProfile();
        if (!active) return;

        const defaultName = `${this.getProfileLabel(active)} (copy)`;
        const name = await this.dialogService.prompt(this.ui().PROFILE_CLONE_PROMPT, {
            defaultValue: defaultName,
            title: this.ui().PROFILE_CLONE
        });
        if (!name) return;

        if (this.hasAnyDirty()) {
            const ok = await this.dialogService.confirm(this.ui().PROFILE_SWITCH_DISCARD_CONFIRM);
            if (!ok) return;
        }

        this.isSwitchingProfile.set(true);
        try {
            const newId = await this.injection.cloneProfile(active.id, name);
            await this.injection.switchProfile(newId);
            this.refreshAllEditorContent();
            this.dirtyState.set(new Map());
            this.snackBar.open(this.ui().PROFILE_CLONED, this.ui().CLOSE, { duration: 2000 });
        } catch (err) {
            console.error('[ChatConfig] cloneActive failed', err);
            this.snackBar.open(this.ui().PROFILE_OP_FAILED, this.ui().CLOSE, { duration: 3000 });
        } finally {
            this.isSwitchingProfile.set(false);
        }
    }

    async renameActive(): Promise<void> {
        const active = this.activeProfile();
        if (!active || active.isBuiltIn) return;

        const current = active.displayName || '';
        const name = await this.dialogService.prompt(this.ui().PROFILE_RENAME_PROMPT, {
            defaultValue: current,
            title: this.ui().PROFILE_RENAME
        });
        if (!name || name === current) return;

        try {
            await this.injection.renameProfile(active.id, name);
            this.snackBar.open(this.ui().PROFILE_RENAMED, this.ui().CLOSE, { duration: 2000 });
        } catch (err) {
            console.error('[ChatConfig] renameActive failed', err);
            this.snackBar.open(this.ui().PROFILE_OP_FAILED, this.ui().CLOSE, { duration: 3000 });
        }
    }

    /** Switches to a fallback profile first so the app never points at a deleted id. */
    async deleteActive(): Promise<void> {
        const active = this.activeProfile();
        if (!active || active.isBuiltIn) return;

        const confirmMsg = this.ui().PROFILE_DELETE_CONFIRM.replace('{name}', this.getProfileLabel(active));
        const ok = await this.dialogService.confirm(confirmMsg, this.ui().PROFILE_DELETE);
        if (!ok) return;

        if (this.hasAnyDirty()) {
            const discardOk = await this.dialogService.confirm(this.ui().PROFILE_SWITCH_DISCARD_CONFIRM);
            if (!discardOk) return;
        }

        this.isSwitchingProfile.set(true);
        try {
            const fallbackId = active.baseProfileId && this.registry.get(active.baseProfileId)
                ? active.baseProfileId
                : DEFAULT_PROFILE_ID;
            await this.injection.switchProfile(fallbackId);
            await this.injection.deleteProfile(active.id);
            this.refreshAllEditorContent();
            this.dirtyState.set(new Map());
            this.snackBar.open(this.ui().PROFILE_DELETED, this.ui().CLOSE, { duration: 2000 });
        } catch (err) {
            console.error('[ChatConfig] deleteActive failed', err);
            this.snackBar.open(this.ui().PROFILE_OP_FAILED, this.ui().CLOSE, { duration: 3000 });
        } finally {
            this.isSwitchingProfile.set(false);
        }
    }

    async pushPromptsToCloud(): Promise<void> {
        this.loading.show(this.ui().PROMPT_SYNC_UPLOADING);
        try {
            const { exported } = await this.sync.uploadPrompts();
            this.snackBar.open(this.ui().PROMPT_SYNC_UPLOADED.replace('{count}', String(exported)), this.ui().CLOSE, { duration: 3000 });
        } catch (err) {
            console.error('[ChatConfig] uploadPrompts failed', err);
            this.snackBar.open(this.ui().PROMPT_SYNC_FAILED, this.ui().CLOSE, { duration: 4000 });
        } finally {
            this.loading.hide();
        }
    }

    async pullPromptsFromCloud(): Promise<void> {
        const confirmed = await this.dialogService.confirm(
            this.ui().PROMPT_SYNC_DOWNLOAD_CONFIRM,
            this.ui().PROMPT_SYNC_DOWNLOAD_TITLE
        );
        if (!confirmed) return;

        this.loading.show(this.ui().PROMPT_SYNC_DOWNLOADING);
        try {
            const { imported } = await this.sync.downloadPrompts();
            // forceReload — switchProfile(sameId) would early-return and skip the re-read.
            await this.injection.forceReload();
            this.refreshAllEditorContent();
            this.dirtyState.set(new Map());
            const msg = imported === 0
                ? this.ui().PROMPT_SYNC_NONE_FOUND
                : this.ui().PROMPT_SYNC_DOWNLOADED.replace('{count}', String(imported));
            this.snackBar.open(msg, this.ui().CLOSE, { duration: 3000 });
        } catch (err) {
            console.error('[ChatConfig] downloadPrompts failed', err);
            this.snackBar.open(this.ui().PROMPT_SYNC_FAILED, this.ui().CLOSE, { duration: 4000 });
        } finally {
            this.loading.hide();
        }
    }

    async exportActiveProfile(): Promise<void> {
        const active = this.activeProfile();
        if (!active) return;
        try {
            const json = await this.sync.exportSingleProfile(active.id);
            const safeName = (this.getProfileLabel(active) || active.id).replace(/[^\w-]+/g, '_');
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = this.win.document.createElement('a');
            a.href = url;
            a.download = `prompt-profile-${safeName}.json`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('[ChatConfig] exportActiveProfile failed', err);
            this.snackBar.open(this.ui().PROFILE_OP_FAILED, this.ui().CLOSE, { duration: 3000 });
        }
    }

    importProfileFromFile(): void {
        const input = this.win.document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const before = new Set(this.registry.userProfiles().map(p => p.id));
                const { imported } = await this.sync.importSingleProfile(text);
                if (imported === 0) {
                    this.snackBar.open(this.ui().PROFILE_IMPORT_EMPTY, this.ui().CLOSE, { duration: 3000 });
                    return;
                }
                // A fresh id means a new user profile appeared (incl. rename-on-conflict);
                // no fresh id means the import overwrote an existing one in place.
                const after = this.registry.userProfiles();
                const fresh = after.find(p => !before.has(p.id));
                if (fresh) {
                    await this.injection.switchProfile(fresh.id);
                } else {
                    await this.injection.forceReload();
                }
                this.refreshAllEditorContent();
                this.dirtyState.set(new Map());
                this.snackBar.open(this.ui().PROFILE_IMPORTED, this.ui().CLOSE, { duration: 3000 });
            } catch (err) {
                console.error('[ChatConfig] importProfileFromFile failed', err);
                this.snackBar.open(this.ui().PROFILE_IMPORT_INVALID, this.ui().CLOSE, { duration: 4000 });
            }
        };
        input.click();
    }

    diskFolderName(): string | null {
        return this.diskSync.boundFolderName();
    }

    async pushActiveProfileToDisk(): Promise<void> {
        const active = this.activeProfile();
        if (!active || active.isBuiltIn) return;

        if (!this.diskFolderName()) {
            try {
                await this.diskSync.pickFolder();
            } catch (err) {
                if ((err as Error)?.name === 'AbortError') return;
                console.error('[ChatConfig] disk pickFolder failed', err);
                this.snackBar.open(this.ui().DISK_SYNC_FAILED, this.ui().CLOSE, { duration: 3000 });
                return;
            }
        }

        this.loading.show(this.ui().DISK_SYNC_PUSHING);
        try {
            await this.diskSync.pushActiveToDisk();
            this.snackBar.open(this.ui().DISK_SYNC_PUSHED, this.ui().CLOSE, { duration: 3000 });
        } catch (err) {
            console.error('[ChatConfig] pushActiveProfileToDisk failed', err);
            this.snackBar.open(this.ui().DISK_SYNC_FAILED, this.ui().CLOSE, { duration: 4000 });
        } finally {
            this.loading.hide();
        }
    }

    async pullActiveProfileFromDisk(): Promise<void> {
        const active = this.activeProfile();
        if (!active || active.isBuiltIn) return;

        if (!this.diskFolderName()) {
            try {
                await this.diskSync.pickFolder();
            } catch (err) {
                if ((err as Error)?.name === 'AbortError') return;
                console.error('[ChatConfig] disk pickFolder failed', err);
                this.snackBar.open(this.ui().DISK_SYNC_FAILED, this.ui().CLOSE, { duration: 3000 });
                return;
            }
        }

        if (this.hasAnyDirty()) {
            const ok = await this.dialogService.confirm(this.ui().DISK_SYNC_PULL_DISCARD_CONFIRM);
            if (!ok) return;
        }

        this.loading.show(this.ui().DISK_SYNC_PULLING);
        try {
            const { updatedTypes } = await this.diskSync.pullActiveFromDisk();
            this.refreshAllEditorContent();
            this.dirtyState.set(new Map());
            const msg = updatedTypes === 0
                ? this.ui().DISK_SYNC_PULL_EMPTY
                : this.ui().DISK_SYNC_PULLED.replace('{count}', String(updatedTypes));
            this.snackBar.open(msg, this.ui().CLOSE, { duration: 3000 });
        } catch (err) {
            console.error('[ChatConfig] pullActiveProfileFromDisk failed', err);
            this.snackBar.open(this.ui().DISK_SYNC_FAILED, this.ui().CLOSE, { duration: 4000 });
        } finally {
            this.loading.hide();
        }
    }

    async changeDiskFolder(): Promise<void> {
        try {
            await this.diskSync.pickFolder();
            const name = this.diskFolderName();
            if (name) {
                this.snackBar.open(
                    this.ui().DISK_SYNC_FOLDER_BOUND.replace('{name}', name),
                    this.ui().CLOSE,
                    { duration: 3000 }
                );
            }
        } catch (err) {
            if ((err as Error)?.name === 'AbortError') return;
            console.error('[ChatConfig] changeDiskFolder failed', err);
            this.snackBar.open(this.ui().DISK_SYNC_FAILED, this.ui().CLOSE, { duration: 3000 });
        }
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
            const ok = await this.dialogService.confirm(this.ui().UNSAVED_CHANGES_CONFIRM);
            if (!ok) return;
        }

        const editor = this.editorRef();
        const currentScript = editor?.getFileContent('postprocess') ?? this.state.postProcessScript();
        const validation = this.postProcessor.validate(currentScript);

        if (!validation.valid) {
            const confirmMsg = this.ui().POST_PROCESS_INVALID_CONFIRM.replace('{error}', validation.error ?? '');
            const ok = await this.dialogService.confirm(confirmMsg);
            if (!ok) {
                if (this.activeType() !== 'postprocess') this.selectType('postprocess');
                return;
            }
        }

        this.dialogRef.close();
    }
}
