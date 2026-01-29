import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { NewGameDialogComponent } from '../new-game-dialog/new-game-dialog.component';

import { GameEngineService } from '../../../../core/services/game-engine.service';
import { GameStateService, GameEngineConfig } from '../../../../core/services/game-state.service';
import { DialogService } from '../../../../core/services/dialog.service';
import { SessionService } from '../../../../core/services/session.service';
import { FileSystemService } from '../../../../core/services/file-system.service';
import { GoogleDriveService } from '../../../../core/services/google-drive.service';
import { CacheManagerService } from '../../../../core/services/cache-manager.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SaveNameDialogComponent } from '../../../../shared/components/save-name-dialog/save-name-dialog.component';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '../../../../core/services/config.service';

@Component({
    selector: 'app-sidebar-context-controls',
    standalone: true,
    imports: [CommonModule, MatButtonModule, MatIconModule, MatDividerModule, MatTooltipModule, MatDialogModule],
    templateUrl: './sidebar-context-controls.component.html',
    styleUrl: './sidebar-context-controls.component.scss'
})
export class SidebarContextControlsComponent {
    engine = inject(GameEngineService);
    state = inject(GameStateService);
    dialog = inject(DialogService);
    session = inject(SessionService);
    fileSystem = inject(FileSystemService);
    driveService = inject(GoogleDriveService);
    snackBar = inject(MatSnackBar);
    configService = inject(ConfigService);
    cacheManager = inject(CacheManagerService);
    private matDialog = inject(MatDialog);

    hasStorageTarget = computed(() => {
        const localReady = this.fileSystem.hasHandle();
        const googleReady = this.driveService.isAuthenticated() && !!this.driveService.currentSlotId();
        return localReady || googleReady;
    });

    startSession() {
        this.engine.startSession();
    }

    /**
     * Creates the next Act by renaming the current book and creating a new one.
     */
    async createNext() {
        if (!this.session.currentBookId()) {
            this.snackBar.open('No active session (Book) to create next from.', 'OK');
            return;
        }

        if (!await this.dialog.confirm(
            'This will:\n1. Rename the current session to "[Slot] Act.N"\n2. Create a NEW session "[Slot] Act.N+1" with copied memory\n3. Switch to the new session\n\nContinue?',
            'Create Next Act', 'Create', 'Cancel'
        )) {
            return;
        }

        this.state.status.set('loading');
        try {
            await this.session.createNextBook();
            this.snackBar.open('Created next Act successfully.', 'OK', { duration: 3000 });

            // Initialize the story for the new act
            this.engine.startSession();

        } catch (e) {
            console.error('Failed to create next Act', e);
            this.snackBar.open('Failed to create next Act.', 'Close');
        } finally {
            this.state.status.set('idle');
        }
    }


    newGame() {
        this.matDialog.open(NewGameDialogComponent, {
            width: '600px',
            disableClose: true
        });
    }

    async clearHistory() {
        if (await this.dialog.confirm('Are you sure you want to delete all chat history and restart?')) {
            this.engine.clearHistory();
        }
    }

    async clearServerData() {
        if (await this.dialog.confirm('Clear the active Cloud Cache for this session? Billing for this context will stop, and it will be re-uploaded on the next turn.')) {
            await this.cacheManager.cleanupCache();
            await this.dialog.alert(`Active cache cleared.`);
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
        const currentTurns = this.state.config()?.smartContextTurns ?? 10;
        const dialogRef = this.matDialog.open(SaveNameDialogComponent, {
            width: '400px',
            data: {
                title: 'Smart Context Full-sized Turns',
                initialName: currentTurns.toString(),
                placeholder: 'Enter number of turns (e.g. 10)',
                inputType: 'number',
                min: 1
            }
        });

        const result = await firstValueFrom(dialogRef.afterClosed());
        if (result) {
            const turns = parseInt(result, 10);
            if (!isNaN(turns) && turns > 0) {
                const cfg = this.state.config();
                if (cfg) {
                    const newConfig: GameEngineConfig = {
                        ...cfg,
                        smartContextTurns: turns
                    };
                    await this.configService.saveConfig(cfg.apiKey || '', cfg.modelId || '', newConfig);
                    this.snackBar.open(`Smart context set to ${turns} turns.`, 'OK', { duration: 3000 });
                }
            } else {
                this.snackBar.open('Invalid turn count.', 'OK', { duration: 3000 });
            }
        }
    }
}
