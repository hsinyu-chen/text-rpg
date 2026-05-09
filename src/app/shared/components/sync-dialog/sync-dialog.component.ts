import { Component, inject, signal, computed, WritableSignal } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule, MatTabChangeEvent } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FileSystemService } from '@app/core/services/file-system.service';
import { GameEngineService } from '@app/core/services/game-engine.service';

import { CacheManagerService } from '@app/core/services/cache-manager.service';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { I18nService, TranslatePipe } from '@app/core/i18n';

export interface SyncItem {
    name: string;
    localContent: string;
    remoteContent: string;
    status: 'changed' | 'identical' | 'new_in_db' | 'new_on_disk';
    selected: boolean;
}

export interface SyncDialogData {
    items: SyncItem[];
    diskHandle: FileSystemDirectoryHandle;
}

@Component({
    selector: 'app-sync-dialog',
    standalone: true,
    imports: [
        MatDialogModule,
        MatButtonModule,
        MatCheckboxModule,
        MatTabsModule,
        MatIconModule,
        MatProgressSpinnerModule,
        FormsModule,
        MonacoEditorComponent,
        TranslatePipe
    ],
    templateUrl: './sync-dialog.component.html',
    styleUrl: './sync-dialog.component.scss'
})
export class SyncDialogComponent {
    public dialogRef = inject(MatDialogRef<SyncDialogComponent>);
    public data = inject<SyncDialogData>(MAT_DIALOG_DATA);

    private snackBar = inject(MatSnackBar);
    private i18n = inject(I18nService);
    private fileSystem = inject(FileSystemService);
    private cacheManager = inject(CacheManagerService);

    private engine = inject(GameEngineService);

    syncItems = signal<{
        name: string;
        localContent: WritableSignal<string>;
        remoteContent: string;
        status: SyncItem['status'];
        selected: WritableSignal<boolean>;
    }[]>([]);
    isSyncing = signal(false);
    currentTabIndex = signal(0);

    constructor() {
        this.syncItems.set(this.data.items.map(i => ({
            ...i,
            localContent: signal(i.localContent),
            selected: signal(i.status !== 'identical')
        })));
    }

    currentItem = computed(() => this.syncItems()[this.currentTabIndex()]);
    editorOptions = computed(() => ({
        readOnly: false,
        renderSideBySide: true
    }));

    onTabChange(event: MatTabChangeEvent) {
        this.currentTabIndex.set(event.index);
    }

    hasSelected(): boolean {
        return this.syncItems().some(i => i.selected());
    }
    onCancel() { this.dialogRef.close(); }

    async onConfirm() {
        this.isSyncing.set(true);
        try {
            const selectedItems = this.syncItems().filter(i => i.selected());

            // IDB before disk: localContent() may carry user edits made on
            // the right side of the diff, and the disk mirror must come
            // from the same authoritative copy that engine state holds.
            for (const item of selectedItems) {
                await this.engine.updateSingleFile(item.name, item.localContent());
            }

            for (const item of selectedItems) {
                await this.fileSystem.writeToDiskHandle(this.data.diskHandle, item.name, item.localContent());
            }
            this.snackBar.open(
                this.i18n.translate('dialog.syncSuccess', { count: selectedItems.length }),
                this.i18n.translate('ui.CLOSE'),
                { duration: 3000 },
            );

            await this.cacheManager.clearAllServerCaches();

            this.dialogRef.close(true);
        } catch (error) {
            console.error(error);
            this.snackBar.open(
                this.i18n.translate('dialog.syncFailedPrefix') + ((error as { message?: string })?.message || 'Unknown error'),
                this.i18n.translate('ui.CLOSE'),
            );
        } finally {
            this.isSyncing.set(false);
        }
    }
}
