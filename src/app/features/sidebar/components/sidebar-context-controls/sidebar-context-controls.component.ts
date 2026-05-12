import { Component, inject } from '@angular/core';
import { DecimalPipe, TitleCasePipe } from '@angular/common';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { NewGameDialogComponent } from '../new-game-dialog/new-game-dialog.component';
import { CreateSceneDialogComponent } from '../create-scene-dialog/create-scene-dialog.component';

import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { DialogService } from '@app/core/services/dialog.service';
import { SessionService } from '@app/core/services/session.service';
import { FileSystemService } from '@app/core/services/file-system.service';
import { CacheManagerService } from '@app/core/services/cache-manager.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SaveNameDialogComponent } from '@app/shared/components/save-name-dialog/save-name-dialog.component';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '@app/core/services/config.service';
import { I18nService, TranslatePipe } from '@app/core/i18n';

@Component({
    selector: 'app-sidebar-context-controls',
    standalone: true,
    imports: [...CORE_MAT, MatDividerModule, MatDialogModule, DecimalPipe, TitleCasePipe, TranslatePipe],
    templateUrl: './sidebar-context-controls.component.html',
    styleUrl: './sidebar-context-controls.component.scss'
})
export class SidebarContextControlsComponent {
    engine = inject(GameEngineService);
    state = inject(GameStateService);
    protected appConfig = inject(AppConfigStore);
    dialog = inject(DialogService);
    session = inject(SessionService);
    fileSystem = inject(FileSystemService);
    snackBar = inject(MatSnackBar);
    configService = inject(ConfigService);
    cacheManager = inject(CacheManagerService);
    private matDialog = inject(MatDialog);
    private i18n = inject(I18nService);

    private t(key: string, params?: Record<string, string | number>): string {
        return this.i18n.translate(`sidebar.controls.${key}`, params);
    }

    startSession() {
        void this.engine.startSession();
    }

    /**
     * Creates the next Act by renaming the current book and creating a new one.
     */
    async createNext() {
        if (!this.session.currentBookId()) {
            this.snackBar.open(this.t('createNextNoSession'), this.i18n.translate('ui.CLOSE'));
            return;
        }

        if (!await this.dialog.confirm(
            this.t('createNextConfirm'),
            this.t('createNextDialogTitle'),
            this.t('createNextConfirmBtn'),
            this.i18n.translate('ui.CANCEL'),
        )) {
            return;
        }

        this.state.status.set('loading');
        try {
            await this.session.createNextBook();
            this.snackBar.open(this.t('createNextSuccess'), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
            await this.engine.startSession();

        } catch (e) {
            console.error('Failed to create next Act', e);
            this.snackBar.open(this.t('createNextFailed'), this.i18n.translate('ui.CLOSE'));
        } finally {
            this.state.status.set('idle');
        }
    }


    newGame() {
        this.matDialog.open(NewGameDialogComponent, {
            width: '760px',
            disableClose: true
        });
    }

    createScene() {
        this.matDialog.open(CreateSceneDialogComponent, {
            width: '1200px',
            maxWidth: '95vw',
            disableClose: true,
            autoFocus: false
        });
    }

    async clearHistory() {
        if (await this.dialog.confirm(this.t('clearHistoryConfirm'))) {
            await this.engine.clearHistory();
        }
    }

    async clearServerData() {
        if (await this.dialog.confirm(this.t('clearCacheConfirm'))) {
            await this.cacheManager.cleanupCache();
            await this.dialog.alert(this.t('clearCacheSuccess'));
        }
    }

    toggleContextMode() {
        this.state.contextMode.update(m => {
            if (m === 'smart') return 'summarized';
            if (m === 'summarized') return 'full';
            return 'smart';
        });
    }

    toggleSaveContextMode() {
        this.state.saveContextMode.update(m => {
            if (m === 'summarized') return 'full';
            if (m === 'full') return 'smart';
            return 'summarized';
        });
    }

    async editSmartContextTurns() {
        const currentTurns = this.appConfig.smartContextTurns();
        const dialogRef = this.matDialog.open(SaveNameDialogComponent, {
            width: '400px',
            data: {
                title: this.t('smartContextDialogTitle'),
                initialName: currentTurns.toString(),
                placeholder: this.t('smartContextPlaceholder'),
                inputType: 'number',
                min: 1
            }
        });

        const result = await firstValueFrom(dialogRef.afterClosed());
        if (result) {
            const turns = parseInt(result, 10);
            if (!isNaN(turns) && turns > 0) {
                await this.configService.saveConfig({ smartContextTurns: turns });
                this.snackBar.open(this.t('smartContextSetSuccess', { turns }), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
            } else {
                this.snackBar.open(this.t('invalidTurnCount'), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
            }
        }
    }
}
