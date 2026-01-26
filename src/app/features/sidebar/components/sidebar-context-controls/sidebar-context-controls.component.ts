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
     * Extracts Act name, saves the session, and starts a new one.
     */
    async saveAndNext() {
        if (this.state.messages().length === 0) {
            this.snackBar.open('No history to save.', 'OK', { duration: 3000 });
            return;
        }

        let saveName = this.session.extractActName();
        const isCloud = !!this.driveService.currentSlotId();
        const cloudSlotId = this.driveService.currentSlotId();

        // Check for duplicates if we have a name
        if (saveName) {
            const isDuplicate = await this.checkDuplicateName(saveName, isCloud, cloudSlotId);
            if (isDuplicate) {
                saveName = await this.promptForName(`Name "${saveName}" already exists. Please enter a new name:`, saveName);
            }
        } else {
            saveName = await this.promptForName('Could not extract Act name. Please enter a save name:');
        }

        if (!saveName) return; // User cancelled

        // Perform Save
        this.state.status.set('loading');
        try {
            const currentSession = this.session.exportSession();
            const saveId = crypto.randomUUID();
            const filename = `${saveId}.json`;
            const save = {
                ...currentSession,
                id: saveId,
                name: saveName,
                timestamp: Date.now()
            };
            const content = JSON.stringify(save, null, 2);

            if (isCloud && cloudSlotId) {
                await this.driveService.uploadSave(save, cloudSlotId);
            } else if (this.fileSystem.hasHandle()) {
                await this.fileSystem.writeSaveFile(filename, content);
            } else {
                throw new Error('No storage target (Local Folder or Cloud Slot) selected.');
            }

            this.snackBar.open(`Saved to slot: ${saveName}`, 'OK', { duration: 3000 });

            // Restart Session
            this.engine.clearHistory();
            this.engine.startSession();

        } catch (err) {
            console.error('[SidebarContext] Save & Next failed:', err);
            this.snackBar.open(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'Close', { duration: 5000 });
        } finally {
            this.state.status.set('idle');
        }
    }

    private async checkDuplicateName(name: string, isCloud: boolean, cloudSlotId: string | null): Promise<boolean> {
        try {
            if (isCloud && cloudSlotId) {
                const cloudSaves = await this.driveService.listSaves(cloudSlotId);
                for (const f of cloudSaves) {
                    const content = await this.driveService.readFile(f.id);
                    const data = JSON.parse(content);
                    if (data.name === name) return true;
                }
            } else if (this.fileSystem.hasHandle()) {
                const localSaves = await this.fileSystem.listLocalSaves();
                for (const f of localSaves) {
                    const content = await this.fileSystem.readSaveFile(f.name);
                    const data = JSON.parse(content);
                    if (data.name === name) return true;
                }
            }
        } catch (e) {
            console.warn('[SidebarContext] Duplicate check failed, assuming no duplicate:', e);
        }
        return false;
    }

    private async promptForName(title: string, initialName = ''): Promise<string | null> {
        const dialogRef = this.matDialog.open(SaveNameDialogComponent, {
            width: '400px',
            data: { title, initialName }
        });
        const result = await firstValueFrom(dialogRef.afterClosed());
        return result || null;
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

    async clearServerDataAndStats() {
        if (await this.dialog.confirm('Delete ALL server-side caches and RESET all cost/usage statistics? This will ensure state safety and reset your billed token counters for the current session.')) {
            const count = await this.engine.clearAllServerCaches();
            await this.dialog.alert(`Successfully cleared ${count} caches and reset all usage statistics. Session state refreshed.`);
        }
    }

    async wipeLocalSession() {
        if (await this.dialog.confirm('Are you sure you want to WIPE all local data? This will delete all chat history, scenario files, and manual saves stored in this browser. This action CANNOT be undone.')) {
            await this.engine.wipeLocalSession();
            await this.dialog.alert('Local session has been completely wiped.');
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
