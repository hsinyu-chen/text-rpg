import { Injectable, inject, effect, signal } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { GameEngineService } from './game-engine.service';
import { FileSystemService } from './file-system.service';
import { GoogleDriveService } from './google-drive.service';
import { SessionSave } from '../models/types';

@Injectable({
    providedIn: 'root'
})
export class AutoSaveService {
    private engine = inject(GameEngineService);
    private fileSystem = inject(FileSystemService);
    private driveService = inject(GoogleDriveService);
    private snackBar = inject(MatSnackBar);

    // Public signal for UI spinners
    isSaving = signal(false);

    private hasPendingSave = false;

    // Minimum interval between saves to avoid spamming
    private readonly DEBOUNCE_MS = 2000;
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    private previousStatus: 'idle' | 'loading' | 'generating' | 'error' = 'idle';

    constructor() {
        // Monitor engine status to trigger auto-save
        effect(() => {
            const status = this.engine.status();

            // Only trigger if we are coming from 'generating' state
            // This prevents auto-save on 'loading' -> 'idle' (e.g. initial load, switching folders)
            if (status === 'idle' && this.previousStatus === 'generating') {
                this.scheduleSave();
            }

            this.previousStatus = status;
        });
    }

    private scheduleSave() {
        // If we have no messages, nothing to save
        if (this.engine.messages().length === 0) return;

        // Clear existing timer if any (debounce)
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        this.debounceTimer = setTimeout(() => {
            this.triggerSave();
        }, this.DEBOUNCE_MS);
    }

    private triggerSave() {
        this.hasPendingSave = true;
        this.processQueue();
    }

    private async processQueue() {
        if (this.isSaving()) return;

        this.isSaving.set(true);

        try {
            // Keep saving as long as there is a pending request
            // This ensures that if a new request came in while we were saving, 
            // we run again with the LATEST data immediately after.
            while (this.hasPendingSave) {
                // Clear flag BEFORE work starts. 
                // If a new request comes in DURING work, it will set flag to true, causing loop to repeat.
                this.hasPendingSave = false;

                await this.performAutoSave();
            }
        } catch (err) {
            console.error('[AutoSave] Queue Error', err);
        } finally {
            this.isSaving.set(false);
        }
    }

    private async performAutoSave() {
        const messages = this.engine.messages();
        if (messages.length === 0) return;

        try {
            const saveId = 'autosave';
            const saveName = 'AutoSave';

            // Construct payload manually or via engine helper
            const currentSession = this.engine.exportSession();

            const save: SessionSave = {
                ...currentSession,
                id: saveId,
                name: saveName,
                timestamp: Date.now()
            };

            const content = JSON.stringify(save, null, 2);
            let saved = false;

            // 1. Local Auto-Save
            if (this.fileSystem.hasHandle()) {
                await this.fileSystem.writeSaveFile(`${saveId}.json`, content);
                saved = true;
            }
            // 2. Cloud Auto-Save (Fallback if no local folder, or parallel? User request implied "when selecting local... OR cloud...")
            // The requirement: "當有選擇本地資料夾、雲端資料夾時" (When local folder OR cloud folder is selected)
            // Implementation: We check both. If a cloud slot is active, we also save there.

            // NOTE: SidebarFileSync uses 'kb_slot_id' in localStorage.
            const cloudSlotId = localStorage.getItem('kb_slot_id');
            const isCloudAuth = this.driveService.isAuthenticated();

            if (cloudSlotId && isCloudAuth) {
                await this.driveService.uploadSave(save, cloudSlotId);
                saved = true;
            }

            if (saved) {
                console.log('[AutoSave] Auto-save complete');
            }

        } catch (e) {
            console.error('[AutoSave] Failed', e);
            // Don't show snackbar error to avoid annoying user in background
        }
    }
}
