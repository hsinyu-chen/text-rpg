import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';

export interface PromptDialogData {
    title?: string;
    message: string;
    defaultValue?: string;
    placeholder?: string;
    okText?: string;
    cancelText?: string;
}

@Component({
    selector: 'app-prompt-dialog',
    standalone: true,
    imports: [CommonModule, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule],
    templateUrl: './prompt-dialog.component.html',
    styleUrl: './prompt-dialog.component.scss'
})
export class PromptDialogComponent {
    public dialogRef = inject<MatDialogRef<PromptDialogComponent, string | null>>(MatDialogRef);
    public data = inject<PromptDialogData>(MAT_DIALOG_DATA);

    value = signal<string>(this.data.defaultValue ?? '');

    submit(): void {
        const trimmed = this.value().trim();
        this.dialogRef.close(trimmed.length > 0 ? trimmed : null);
    }

    cancel(): void {
        this.dialogRef.close(null);
    }
}
