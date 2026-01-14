import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SessionSave } from '../../../core/models/types';
import { GoogleDriveService } from '../../../core/services/google-drive.service';
import { LoadingService } from '../../../core/services/loading.service';
import { DialogService } from '../../../core/services/dialog.service';
import { GameEngineService } from '../../../core/services/game-engine.service';
import { FileSystemService } from '../../../core/services/file-system.service';

export interface SaveSlotDialogData {
    currentSession: SessionSave | null;
    localOnly?: boolean;
}

interface SaveSlotItem {
    name: string; // The filename (e.g. uuid.json)
    displayName: string; // The "name" property inside JSON
    lastModified: number;
    storyPreview?: string;
    kbHash?: string;
    fullData?: SessionSave; // Optional cache of loaded data
    driveFileId?: string; // Only for cloud
}

@Component({
    selector: 'app-save-slots-dialog',
    standalone: true,
    imports: [
        CommonModule,
        MatDialogModule,
        MatButtonModule,
        MatIconModule,
        MatListModule,
        MatInputModule,
        MatFormFieldModule,
        MatProgressSpinnerModule,
        MatTooltipModule,
        FormsModule
    ],
    templateUrl: './save-slots-dialog.component.html',
    styleUrl: './save-slots-dialog.component.scss'
})
export class SaveSlotsDialogComponent {
    private dialogRef = inject(MatDialogRef<SaveSlotsDialogComponent>);
    public data = inject<SaveSlotDialogData>(MAT_DIALOG_DATA);
    private engine = inject(GameEngineService);
    private driveService = inject(GoogleDriveService);
    private loading = inject(LoadingService);
    private dialog = inject(DialogService);
    private snackBar = inject(MatSnackBar);
    private fileSystem = inject(FileSystemService);

    slots = signal<SaveSlotItem[]>([]);
    isLoading = signal(false);
    newSaveName = signal('');
    showNewSaveInput = signal(false);

    // Derived context
    isLocalMode = signal(this.data.localOnly || false);
    cloudSlotId = signal(localStorage.getItem('kb_slot_id'));

    constructor() {
        this.loadSlots();
    }

    async loadSlots() {
        this.isLoading.set(true);
        this.loading.show('Loading Save Slots...');
        try {
            const items: SaveSlotItem[] = [];

            if (this.isLocalMode()) {
                const diskSaves = await this.fileSystem.listLocalSaves();
                for (const diskFile of diskSaves) {
                    try {
                        const content = await this.fileSystem.readSaveFile(diskFile.name);
                        const saveData = JSON.parse(content) as SessionSave;
                        items.push({
                            name: diskFile.name,
                            displayName: saveData.name,
                            lastModified: diskFile.lastModified,
                            storyPreview: saveData.storyPreview,
                            kbHash: saveData.kbHash,
                            fullData: saveData
                        });
                    } catch (e) {
                        console.warn('Failed to parse local save:', diskFile.name, e);
                    }
                }
            } else if (this.cloudSlotId()) {
                const cloudSaves = await this.driveService.listSaves(this.cloudSlotId()!);
                for (const cloudFile of cloudSaves) {
                    try {
                        const content = await this.driveService.readFile(cloudFile.id);
                        const saveData = JSON.parse(content) as SessionSave;
                        items.push({
                            name: cloudFile.name,
                            displayName: saveData.name,
                            lastModified: new Date(cloudFile.modifiedTime || 0).getTime(),
                            storyPreview: saveData.storyPreview,
                            kbHash: saveData.kbHash,
                            driveFileId: cloudFile.id,
                            fullData: saveData
                        });
                    } catch (e) {
                        console.warn('Failed to parse cloud save:', cloudFile.name, e);
                    }
                }
            }

            // Sort by lastModified descending
            items.sort((a, b) => b.lastModified - a.lastModified);
            this.slots.set(items);
        } catch (e) {
            console.error('Failed to load slots:', e);
            this.snackBar.open('Failed to load save slots.', 'Close', { duration: 3000 });
        } finally {
            this.isLoading.set(false);
            this.loading.hide();
        }
    }

    formatDate(timestamp: number): string {
        return new Date(timestamp).toLocaleString();
    }

    async onCreateSave() {
        if (!this.data.currentSession) {
            this.snackBar.open('No active session to save.', 'Close', { duration: 3000 });
            return;
        }
        if (!this.newSaveName().trim()) {
            this.snackBar.open('Please enter a save name.', 'Close', { duration: 3000 });
            return;
        }

        this.isLoading.set(true);
        this.loading.show('Creating Save...');
        try {
            const saveId = crypto.randomUUID();
            const filename = `${saveId}.json`;
            const save: SessionSave = {
                ...this.data.currentSession,
                id: saveId,
                name: this.newSaveName().trim(),
                timestamp: Date.now()
            };

            const content = JSON.stringify(save, null, 2);

            if (this.isLocalMode()) {
                await this.fileSystem.writeSaveFile(filename, content);
            } else if (this.cloudSlotId()) {
                await this.driveService.uploadSave(save, this.cloudSlotId()!);
            }

            this.snackBar.open(`Saved "${save.name}" successfully.`, 'OK', { duration: 3000 });
            this.newSaveName.set('');
            this.showNewSaveInput.set(false);
            await this.loadSlots();
        } catch (e) {
            console.error('Failed to create save:', e);
            this.snackBar.open('Failed to create save.', 'Close', { duration: 5000 });
        } finally {
            this.isLoading.set(false);
            this.loading.hide();
        }
    }

    async onOverwrite(item: SaveSlotItem) {
        if (!this.data.currentSession) return;
        if (!await this.dialog.confirm(`Overwrite "${item.displayName}" with current session?`, 'Overwrite Save', 'Overwrite', 'Cancel')) return;

        this.isLoading.set(true);
        this.loading.show('Overwriting Save...');
        try {
            // Keep the same filename/id
            const saveId = item.name.replace('.json', '');
            const save: SessionSave = {
                ...this.data.currentSession,
                id: saveId,
                name: item.displayName,
                timestamp: Date.now()
            };

            const content = JSON.stringify(save, null, 2);

            if (this.isLocalMode()) {
                await this.fileSystem.writeSaveFile(item.name, content);
            } else if (this.cloudSlotId()) {
                await this.driveService.uploadSave(save, this.cloudSlotId()!);
            }

            this.snackBar.open(`Overwrote "${save.name}" successfully.`, 'OK', { duration: 3000 });
            await this.loadSlots();
        } catch (e) {
            console.error('Failed to overwrite save:', e);
            this.snackBar.open('Failed to overwrite save.', 'Close', { duration: 5000 });
        } finally {
            this.isLoading.set(false);
            this.loading.hide();
        }
    }

    async onLoad(item: SaveSlotItem) {
        if (!item.fullData) {
            this.snackBar.open('Save data is corrupted or missing.', 'Close', { duration: 3000 });
            return;
        }

        const currentHash = this.engine.currentKbHash();
        const savedHash = item.fullData.kbHash;

        let confirmMessage = `Load save "${item.displayName}"? Unsaved progress in current session will be lost.`;

        if (savedHash && currentHash && savedHash !== currentHash) {
            confirmMessage = `⚠️ WARNING: This save's Knowledge Base (Hash: ${savedHash.substring(0, 8)}) matches a different version than your current loaded files (Hash: ${currentHash.substring(0, 8)}).\n\nLoading may cause story inconsistencies.\n\nAre you sure you want to load?`;
        }

        if (!await this.dialog.confirm(confirmMessage, 'Load Save', 'Load', 'Cancel')) return;

        this.dialogRef.close({ action: 'load', save: item.fullData });
    }

    async onDelete(item: SaveSlotItem) {
        if (!await this.dialog.confirm(`Permanently delete "${item.displayName}"? This cannot be undone.`, 'Delete Save', 'Delete', 'Cancel')) return;

        this.isLoading.set(true);
        this.loading.show('Deleting Save...');
        try {
            if (this.isLocalMode()) {
                await this.fileSystem.deleteFromLocalDisk(item.name);
            } else {
                await this.driveService.deleteSaveFromDrive(item.driveFileId!);
            }

            this.snackBar.open(`Deleted "${item.displayName}".`, 'OK', { duration: 3000 });
            await this.loadSlots();
        } catch (e) {
            console.error('Failed to delete save:', e);
            this.snackBar.open('Failed to delete save.', 'Close', { duration: 5000 });
        } finally {
            this.isLoading.set(false);
            this.loading.hide();
        }
    }

    onCancel() {
        this.dialogRef.close();
    }

    toggleNewSaveInput() {
        this.showNewSaveInput.update(v => !v);
        if (this.showNewSaveInput()) {
            this.newSaveName.set('');
        }
    }
}
