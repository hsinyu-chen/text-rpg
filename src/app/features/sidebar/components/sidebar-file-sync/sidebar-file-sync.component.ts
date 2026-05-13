import { Component, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { CORE_MAT } from '@app/shared/material/material-groups';

import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { FileSystemService } from '@app/core/services/file-system.service';
import { DialogService } from '@app/core/services/dialog.service';
import { LoadingService } from '@app/core/services/loading.service';
import { SyncDialogComponent, SyncItem, SyncDialogData } from '@app/shared/components/sync-dialog/sync-dialog.component';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { AppAgentHintDirective } from '@app/core/services/agent-hints/agent-hints.directive';

@Component({
    selector: 'app-sidebar-file-sync',
    standalone: true,
    imports: [...CORE_MAT, TranslatePipe, AppAgentHintDirective],
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
    private i18n = inject(I18nService);

    private t(key: string, params?: Record<string, string | number>): string {
        return this.i18n.translate(`sidebar.fileSync.${key}`, params);
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

        if (this.state.loadedFiles().size > 0) {
            if (!await this.dialog.confirm(
                this.t('loadConfirm'),
                this.t('loadDialogTitle'),
                this.t('loadConfirmBtn'),
                this.t('cancelBtn'),
            )) {
                return;
            }
        }

        this.loading.show('Loading files from local folder...');
        try {
            await this.fileSystem.syncDiskToDb();
            await this.engine.loadFiles(false);
            this.snackBar.open(this.t('loadSuccess'), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
        } catch (err) {
            console.error('Load failed', err);
            this.snackBar.open(this.t('loadFailed'), this.i18n.translate('ui.CLOSE'), { duration: 5000 });
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
                await this.dialog.alert(this.t('alreadyInSync'));
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
