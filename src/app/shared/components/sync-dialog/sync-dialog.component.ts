import { Component, inject, signal, computed, WritableSignal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule, MatTabChangeEvent } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FileSystemService } from '../../../core/services/file-system.service';
import { GoogleDriveService } from '../../../core/services/google-drive.service';
import { GameEngineService } from '../../../core/services/game-engine.service';

import { CacheManagerService } from '../../../core/services/cache-manager.service';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';

export type SyncMode = 'DISK' | 'CLOUD';

export interface SyncItem {
    name: string;
    localContent: string;
    remoteContent: string;
    status: 'changed' | 'identical' | 'new_in_db' | 'new_on_disk' | 'new_in_cloud' | 'upload' | 'download' | 'conflict';
    selected: boolean;
    fileId?: string;
}

export interface SyncDialogData {
    mode: SyncMode;
    items: SyncItem[];
    diskHandle?: FileSystemDirectoryHandle;
    parentId?: string;
}

@Component({
    selector: 'app-sync-dialog',
    standalone: true,
    imports: [
        CommonModule,
        MatDialogModule,
        MatButtonModule,
        MatCheckboxModule,
        MatTabsModule,
        MatIconModule,
        MatProgressSpinnerModule,
        FormsModule,
        MonacoEditorComponent
    ],
    templateUrl: './sync-dialog.component.html',
    styleUrl: './sync-dialog.component.scss'
})
export class SyncDialogComponent {
    public dialogRef = inject(MatDialogRef<SyncDialogComponent>);
    public data = inject<SyncDialogData>(MAT_DIALOG_DATA);

    private snackBar = inject(MatSnackBar);
    private fileSystem = inject(FileSystemService);
    private driveService = inject(GoogleDriveService);
    private cacheManager = inject(CacheManagerService);

    private engine = inject(GameEngineService);

    syncItems = signal<{
        name: string;
        localContent: WritableSignal<string>;
        remoteContent: string;
        status: string;
        selected: WritableSignal<boolean>;
        fileId?: string;
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



    get title(): string {
        return this.data.mode === 'DISK' ? 'Sync to Local Folder' : 'Sync to Google Drive';
    }

    get icon(): string {
        return this.data.mode === 'DISK' ? 'sync' : 'cloud_sync';
    }

    get targetName(): string {
        return this.data.mode === 'DISK' ? 'Disk' : 'Drive';
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

            // 1. Update Database (IndexedDB) first for all selected items
            // This ensures if user edited the right side of the diff, it's saved locally
            for (const item of selectedItems) {
                await this.engine.updateSingleFile(item.name, item.localContent());
            }

            // 2. Update Target (Disk or Cloud)
            if (this.data.mode === 'DISK') {
                if (!this.data.diskHandle) throw new Error('No disk handle provided');

                for (const item of selectedItems) {
                    await this.fileSystem.writeToDiskHandle(this.data.diskHandle, item.name, item.localContent());
                }
                this.snackBar.open(`Successfully synced ${selectedItems.length} files to Disk and DB.`, 'OK', { duration: 3000 });
            } else { // CLOUD
                if (!this.data.parentId) throw new Error('No parent ID provided');

                let count = 0;
                for (const item of selectedItems) {
                    if (item.fileId) {
                        await this.driveService.updateFile(item.fileId, item.localContent());
                    } else {
                        await this.driveService.createFile(this.data.parentId, item.name, item.localContent());
                    }
                    count++;
                }
                this.snackBar.open(`Successfully synced ${count} files to Drive and DB.`, 'OK', { duration: 3000 });
            }

            // [Added] Clear remote cache since files have changed
            await this.cacheManager.clearAllServerCaches();

            this.dialogRef.close(true);
        } catch (error) {
            console.error(error);
            this.snackBar.open(`Sync failed: ${(error as { message?: string })?.message || 'Unknown error'}`, 'Close');
        } finally {
            this.isSyncing.set(false);
        }
    }
}
