import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
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
    protected appConfig = inject(AppConfigStore);
    dialog = inject(DialogService);
    session = inject(SessionService);
    fileSystem = inject(FileSystemService);
    snackBar = inject(MatSnackBar);
    configService = inject(ConfigService);
    cacheManager = inject(CacheManagerService);
    private matDialog = inject(MatDialog);

    startSession() {
        void this.engine.startSession();
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
            await this.engine.startSession();

        } catch (e) {
            console.error('Failed to create next Act', e);
            this.snackBar.open('Failed to create next Act.', 'Close');
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
        if (await this.dialog.confirm('Are you sure you want to delete all chat history and restart?')) {
            await this.engine.clearHistory();
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
        const currentTurns = this.appConfig.smartContextTurns();
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
                await this.configService.saveConfig({ smartContextTurns: turns });
                this.snackBar.open(`Smart context set to ${turns} turns.`, 'OK', { duration: 3000 });
            } else {
                this.snackBar.open('Invalid turn count.', 'OK', { duration: 3000 });
            }
        }
    }
}
