import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { NewGameDialogComponent } from '../new-game-dialog/new-game-dialog.component';

import { GameEngineService } from '../../../../core/services/game-engine.service';
import { DialogService } from '../../../../core/services/dialog.service';

@Component({
    selector: 'app-sidebar-context-controls',
    standalone: true,
    imports: [CommonModule, MatButtonModule, MatIconModule, MatDividerModule, MatTooltipModule, MatDialogModule],
    templateUrl: './sidebar-context-controls.component.html',
    styleUrl: './sidebar-context-controls.component.scss'
})
export class SidebarContextControlsComponent {
    engine = inject(GameEngineService);
    dialog = inject(DialogService);
    private matDialog = inject(MatDialog);

    startSession() {
        this.engine.startSession();
    }

    async releaseCache() {
        if (await this.dialog.confirm('Are you sure you want to release the remote cache? This will stop storage costs but will retain your chat history. The cache will be rebuilt automatically next time you send a message.')) {
            await this.engine.releaseCache();
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

    async clearAllRemoteData() {
        if (await this.dialog.confirm('Delete ALL server-side caches/files and RESTART your current session? This will wipe the conversation and all uploaded data to ensure state safety.')) {
            const count = await this.engine.clearAllServerCaches();
            await this.dialog.alert(`Successfully cleared ${count} caches and all uploaded files. Session restarted.`);
        }
    }

    async wipeLocalSession() {
        if (await this.dialog.confirm('Are you sure you want to WIPE all local data? This will delete all chat history, scenario files, and manual saves stored in this browser. This action CANNOT be undone.')) {
            await this.engine.wipeLocalSession();
            await this.dialog.alert('Local session has been completely wiped.');
        }
    }

    toggleContextMode() {
        this.engine.contextMode.update(m => m === 'smart' ? 'full' : 'smart');
    }
}
