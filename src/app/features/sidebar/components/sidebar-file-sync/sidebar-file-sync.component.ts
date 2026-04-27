import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';

import { GameEngineService } from '../../../../core/services/game-engine.service';
import { GameStateService } from '../../../../core/services/game-state.service';
import { FileSystemService } from '../../../../core/services/file-system.service';
import { DialogService } from '../../../../core/services/dialog.service';
import { LoadingService } from '../../../../core/services/loading.service';
import { SyncDialogComponent, SyncItem, SyncDialogData } from '../../../../shared/components/sync-dialog/sync-dialog.component';

@Component({
    selector: 'app-sidebar-file-sync',
    standalone: true,
    imports: [CommonModule, MatButtonModule, MatIconModule, MatTooltipModule],
    templateUrl: './sidebar-file-sync.component.html',
    styleUrl: './sidebar-file-sync.component.scss'
})
export class SidebarFileSyncComponent {
    engine = inject(GameEngineService);
    state = inject(GameStateService);
    fileSystem = inject(FileSystemService);
    matDialog = inject(MatDialog);
    dialog = inject(DialogService);
    loading = inject(LoadingService);
    snackBar = inject(MatSnackBar);

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
            await this.engine.loadFiles(false);
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
}
