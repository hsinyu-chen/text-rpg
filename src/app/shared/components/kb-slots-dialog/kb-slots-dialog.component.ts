import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { FormsModule } from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { GoogleDriveService } from '../../../core/services/google-drive.service';

export interface KbSlot {
    id: string; // 'appDataFolder' for root, or folderId
    name: string;
    isRoot: boolean;
}

@Component({
    selector: 'app-kb-slots-dialog',
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
        FormsModule
    ],
    templateUrl: './kb-slots-dialog.component.html',
    styleUrl: './kb-slots-dialog.component.scss'
})
export class KbSlotsDialogComponent {
    private dialogRef = inject(MatDialogRef<KbSlotsDialogComponent>);
    private driveService = inject(GoogleDriveService);
    private snackBar = inject(MatSnackBar);

    slots = signal<KbSlot[]>([]);
    isLoading = signal(false);
    showNewSlotInput = signal(false);
    newSlotName = signal('');

    constructor() {
        this.loadSlots();
    }

    async loadSlots() {
        this.isLoading.set(true);
        try {
            // Always include Root as an option
            const items: KbSlot[] = [{
                id: 'appDataFolder',
                name: 'Default / Root',
                isRoot: true
            }];

            const folders = await this.driveService.listFolders();

            // Filter out 'saves' folder as it's reserved
            folders.forEach(f => {
                if (f.name !== 'saves') {
                    items.push({
                        id: f.id,
                        name: f.name,
                        isRoot: false
                    });
                }
            });

            this.slots.set(items);
        } catch (e) {
            console.error('Failed to list folders', e);
            this.snackBar.open('Failed to list Cloud Slots.', 'Close', { duration: 3000 });
        } finally {
            this.isLoading.set(false);
        }
    }

    async createSlot() {
        if (!this.newSlotName().trim()) return;

        this.isLoading.set(true);
        try {
            const folder = await this.driveService.createFolder('appDataFolder', this.newSlotName().trim());
            this.newSlotName.set('');
            this.showNewSlotInput.set(false);
            await this.loadSlots();
            this.snackBar.open(`Created slot "${folder.name}"`, 'OK', { duration: 3000 });
        } catch (e) {
            console.error('Failed to create folder', e);
            this.snackBar.open('Failed to create slot.', 'Close', { duration: 3000 });
        } finally {
            this.isLoading.set(false);
        }
    }

    selectSlot(slot: KbSlot) {
        this.dialogRef.close(slot);
    }

    onCancel() {
        this.dialogRef.close();
    }
}
