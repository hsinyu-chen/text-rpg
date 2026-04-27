import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { Collection } from '../../../core/models/types';

export interface MoveBookDialogData {
    bookName: string;
    currentCollectionId: string;
    collections: Collection[];
}

@Component({
    selector: 'app-move-book-dialog',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatDialogModule,
        MatButtonModule,
        MatFormFieldModule,
        MatSelectModule
    ],
    templateUrl: './move-book-dialog.component.html',
    styleUrl: './move-book-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class MoveBookDialogComponent {
    dialogRef = inject(MatDialogRef<MoveBookDialogComponent, string | undefined>);
    data = inject<MoveBookDialogData>(MAT_DIALOG_DATA);

    targetId = signal<string>(this.data.currentCollectionId);

    canMove = computed(() => this.targetId() !== this.data.currentCollectionId);

    cancel(): void {
        this.dialogRef.close(undefined);
    }

    confirm(): void {
        if (!this.canMove()) return;
        this.dialogRef.close(this.targetId());
    }
}
