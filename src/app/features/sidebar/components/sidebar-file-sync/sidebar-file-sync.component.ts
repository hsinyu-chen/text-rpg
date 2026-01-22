import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { GameEngineService } from '../../../../core/services/game-engine.service';
import { GameStateService } from '../../../../core/services/game-state.service';
import { FileSystemService } from '../../../../core/services/file-system.service';
import { GoogleDriveService } from '../../../../core/services/google-drive.service';
import { DialogService } from '../../../../core/services/dialog.service';
import { LoadingService } from '../../../../core/services/loading.service';
import { AutoSaveService } from '../../../../core/services/auto-save.service';
import { SyncDialogComponent, SyncItem, SyncDialogData } from '../../../../shared/components/sync-dialog/sync-dialog.component';
import { SaveSlotsDialogComponent, SaveSlotDialogData } from '../../../../shared/components/save-slots-dialog/save-slots-dialog.component';
import { KbSlotsDialogComponent, KbSlot } from '../../../../shared/components/kb-slots-dialog/kb-slots-dialog.component';
import { FILENAME_MIGRATIONS } from '../../../../core/constants/migrations';

@Component({
    selector: 'app-sidebar-file-sync',
    standalone: true,
    imports: [CommonModule, MatButtonModule, MatIconModule, MatDividerModule, MatTooltipModule, MatProgressSpinnerModule],
    templateUrl: './sidebar-file-sync.component.html',
    styleUrl: './sidebar-file-sync.component.scss'
})
export class SidebarFileSyncComponent {
    engine = inject(GameEngineService);
    state = inject(GameStateService);
    fileSystem = inject(FileSystemService);
    driveService = inject(GoogleDriveService);
    matDialog = inject(MatDialog);
    dialog = inject(DialogService);
    loading = inject(LoadingService);
    snackBar = inject(MatSnackBar);
    autoSave = inject(AutoSaveService);

    currentSlot = signal<{ id: string; name: string } | null>(null);

    constructor() {
        const savedId = localStorage.getItem('kb_slot_id');
        const savedName = localStorage.getItem('kb_slot_name');
        if (savedId && savedName) {
            this.currentSlot.set({ id: savedId, name: savedName });
            this.driveService.currentSlotId.set(savedId);
        }
    }

    async loadFolder() {
        try {
            await this.fileSystem.selectDirectory();
        } catch (err) {
            console.error('Folder selection failed', err);
        }
    }

    async loadFilesOnly() {
        if (!this.fileSystem.hasHandle()) {
            await this.loadFolder();
            if (!this.fileSystem.hasHandle()) return;
        }

        // Add confirmation if we already have files
        if (this.state.loadedFiles().size > 0) {
            if (!await this.dialog.confirm(
                'This will reload all story files from the selected local folder. Any unsaved changes in IndexedDB will be overwritten. Continue?',
                'Load from Local Folder', 'Load', 'Cancel'
            )) {
                return;
            }
        }

        this.loading.show('Loading files from local folder...');
        try {
            await this.fileSystem.syncDiskToDb();
            await this.engine.loadFiles(false); // Reload based on current handle
            this.snackBar.open('Files loaded successfully.', 'OK', { duration: 3000 });
        } catch (err) {
            console.error('Load failed', err);
            this.snackBar.open('Failed to load files.', 'Close', { duration: 5000 });
        } finally {
            this.loading.hide();
        }
    }

    async syncToDisk() {
        try {
            if (!this.fileSystem.hasHandle()) {
                await this.loadFolder();
                if (!this.fileSystem.hasHandle()) return;
            }

            const handle = this.fileSystem.directoryHandle()!;
            const diffs = await this.fileSystem.compareStorageToDisk(handle);

            const hasDifferences = diffs.some(i => i.status !== 'identical');
            if (!hasDifferences) {
                await this.dialog.alert('Your local IndexedDB is already in sync with the selected folder.');
                return;
            }

            // Map FileSystemSyncItem to Unified SyncItem
            const items: SyncItem[] = diffs.map(d => ({
                name: d.name,
                localContent: d.dbContent,
                remoteContent: d.diskContent,
                status: d.status,
                selected: d.status !== 'identical'
            }));

            const dialogData: SyncDialogData = {
                mode: 'DISK',
                items,
                diskHandle: handle
            };

            this.matDialog.open(SyncDialogComponent, {
                panelClass: 'fullscreen-dialog',
                disableClose: true,
                data: dialogData
            });
        } catch (err) {
            console.error('Sync failed', err);
        }
    }

    async selectSlot() {
        // Authenticate first if needed
        if (!this.driveService.isAuthenticated()) {
            await this.driveService.login();
        }

        const ref = this.matDialog.open(KbSlotsDialogComponent, {
            width: '400px',
            disableClose: false
        });

        const result: KbSlot | undefined = await ref.afterClosed().toPromise();
        if (result) {
            this.currentSlot.set({ id: result.id, name: result.name });
            this.driveService.currentSlotId.set(result.id);
            localStorage.setItem('kb_slot_id', result.id);
            localStorage.setItem('kb_slot_name', result.name);
            return result;
        }
        return null;
    }

    async loadCloudFolder() {
        let slotId = this.currentSlot()?.id;

        if (!slotId) {
            const slot = await this.selectSlot();
            if (!slot) return;
            slotId = slot.id;
        }

        if (!await this.dialog.confirm(
            `This will import files from Cloud Slot "${this.currentSlot()?.name}". Existing files with same names will be overwritten. Continue?`,
            'Load from Cloud', 'Load', 'Cancel'
        )) {
            return;
        }

        await this._performCloudLoad(slotId);
    }

    private async _performCloudLoad(slotId: string) {
        const slotName = this.currentSlot()?.name || slotId;
        this.loading.show(`Loading files from "${slotName}"...`);
        try {
            const files = await this.driveService.listFiles(slotId);
            const folderFiles = new Map<string, string>();

            let loadedCount = 0;
            const promises = files.map(async f => {
                if (f.name.endsWith('.md') || f.mimeType === 'text/markdown' || f.mimeType === 'text/plain') {
                    try {
                        // //MIGRATION CODE START - New filename takes priority
                        const newName = FILENAME_MIGRATIONS[f.name] || f.name;

                        // If this is a legacy file and the new file also exists in cloud, skip it
                        if (FILENAME_MIGRATIONS[f.name]) {
                            const newFileExists = files.some(file => file.name === newName);
                            if (newFileExists) {
                                console.log(`[Migration] Skipping legacy file ${f.name} - new file ${newName} exists`);
                                return; // Skip this legacy file
                            }
                        }
                        // //MIGRATION CODE END

                        const content = await this.driveService.readFile(f.id);
                        if (newName !== f.name) {
                            console.log(`[Migration] Cloud file: ${f.name} → ${newName}`);
                        }
                        folderFiles.set(newName, content);
                        loadedCount++;
                    } catch (e) {
                        console.error(`Failed to load ${f.name}`, e);
                    }
                }
            });

            await Promise.all(promises);

            if (loadedCount > 0) {
                await this.engine.importFiles(folderFiles);
                this.snackBar.open(`Loaded ${loadedCount} files from "${slotName}".`, 'OK', { duration: 3000 });
            } else {
                this.dialog.alert(`No valid files found in "${slotName}".`);
            }
        } catch (e) {
            console.error(e);
            this.snackBar.open('Failed to load from Google Drive. ' + ((e as { message?: string })?.message || ''), 'Close', { duration: 5000 });
        } finally {
            this.loading.hide();
        }
    }

    showAuthWarning = computed(() => this.driveService.hasAuthError());

    async reAuthenticate() {
        try {
            await this.driveService.login();
            // If we are here, login succeeded
            this.snackBar.open('Re-authentication successful. Retrying auto-save...', 'OK', { duration: 2000 });

            // Retry auto-save
            this.autoSave.retryAutoSave();
        } catch (error) {
            console.error('Re-authentication failed', error);
            this.snackBar.open('Re-authentication failed.', 'Close');
        }
    }

    async syncToCloud() {
        let slotId = this.currentSlot()?.id;
        if (!slotId) {
            const slot = await this.selectSlot();
            if (!slot) return;
            slotId = slot.id;
        }

        this.loading.show(`Syncing files to "${this.currentSlot()?.name}"...`);
        try {
            const folderId = slotId;

            // 1. Get remote files (Service handles auth)
            const remoteFiles = await this.driveService.listFiles(folderId);
            const localFiles = this.state.loadedFiles(); // Map<string, string>

            // 2. Compare
            const items: SyncItem[] = [];

            // Check local against remote
            for (const [name, content] of localFiles.entries()) {

                const remote = remoteFiles.find(f => f.name === name);
                if (remote) {
                    // We fetch content to compare
                    const remoteContent = await this.driveService.readFile(remote.id);
                    if (remoteContent !== content) {
                        items.push({
                            name,
                            fileId: remote.id,
                            localContent: content,
                            remoteContent: remoteContent,
                            status: 'conflict', // Using 'conflict' as 'changed' indicator for cloud logic
                            selected: true
                        });
                    }
                } else {
                    // New in DB
                    items.push({
                        name,
                        localContent: content,
                        remoteContent: '',
                        status: 'upload', // 'upload' specific
                        selected: true
                    });
                }
            }

            if (items.length === 0) {
                await this.dialog.alert('All files are in sync with Google Drive App Data.');
                return;
            }

            // 3. Open Dialog
            const dialogData: SyncDialogData = {
                mode: 'CLOUD',
                items,
                parentId: folderId
            };

            await this.matDialog.open(SyncDialogComponent, {
                panelClass: 'fullscreen-dialog',
                disableClose: true,
                data: dialogData
            }).afterClosed().toPromise();

        } catch (e) {
            console.error(e);
            this.snackBar.open('Cloud sync failed. ' + ((e as { message?: string })?.message || ''), 'Close', { duration: 5000 });
        } finally {
            this.loading.hide();
        }
    }

    async openLocalSaveSlots() {
        if (!this.fileSystem.hasHandle()) {
            await this.loadFolder();
            if (!this.fileSystem.hasHandle()) return;
        }

        await this.openSaveSlots(true);
    }

    async openSaveSlots(localOnly = false) {
        const dialogData: SaveSlotDialogData = {
            currentSession: this.state.messages().length > 0 ? this.engine.exportSession() : null,
            localOnly
        };

        const result = await this.matDialog.open(SaveSlotsDialogComponent, {
            width: '550px',
            maxHeight: '80vh',
            data: dialogData
        }).afterClosed().toPromise();

        if (result?.action === 'load' && result.save) {
            // Auto-load KB files if empty
            if (this.state.loadedFiles().size === 0) {
                if (localOnly) {
                    await this.engine.loadFiles(false);
                } else if (this.currentSlot()) {
                    await this._performCloudLoad(this.currentSlot()!.id);
                }
            }

            await this.engine.importSession(result.save);
            this.snackBar.open(`Loaded save "${result.save.name}" successfully.`, 'OK', { duration: 3000 });
        }
    }
}
