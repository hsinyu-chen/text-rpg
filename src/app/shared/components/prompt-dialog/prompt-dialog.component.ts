import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { I18nService } from '@app/core/i18n';

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
    imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule],
    templateUrl: './prompt-dialog.component.html',
    styleUrl: './prompt-dialog.component.scss'
})
export class PromptDialogComponent {
    public dialogRef = inject<MatDialogRef<PromptDialogComponent, string | null>>(MatDialogRef);
    public data = inject<PromptDialogData>(MAT_DIALOG_DATA);
    private i18n = inject(I18nService);

    value = signal<string>(this.data.defaultValue ?? '');

    /** Translated default labels — caller-provided overrides win when present. */
    resolvedTitle = computed(() => this.data.title || this.i18n.translate('dialog.promptTitle'));
    resolvedOkText = computed(() => this.data.okText || this.i18n.translate('dialog.ok'));
    resolvedCancelText = computed(() => this.data.cancelText || this.i18n.translate('dialog.cancel'));

    submit(): void {
        const trimmed = this.value().trim();
        this.dialogRef.close(trimmed.length > 0 ? trimmed : null);
    }

    cancel(): void {
        this.dialogRef.close(null);
    }
}
