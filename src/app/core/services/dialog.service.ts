import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialogComponent, ConfirmDialogData } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { PromptDialogComponent, PromptDialogData } from '../../shared/components/prompt-dialog/prompt-dialog.component';

@Injectable({
    providedIn: 'root'
})
export class DialogService {
    private dialog = inject(MatDialog);

    /**
     * Opens a confirmation dialog.
     * @param message The message to display.
     * @param title Optional title for the dialog.
     * @param okText Optional text for the confirm button.
     * @param cancelText Optional text for the cancel button.
     * @returns A promise resolving to true if confirmed, false otherwise.
     */
    async confirm(message: string, title?: string, okText?: string, cancelText?: string): Promise<boolean> {
        const dialogRef = this.dialog.open(ConfirmDialogComponent, {
            data: {
                title,
                message,
                okText,
                cancelText,
                isAlert: false
            } as ConfirmDialogData,
            maxWidth: '500px'
        });

        return (await firstValueFrom(dialogRef.afterClosed())) ?? false;
    }

    /**
     * Opens a text-input prompt dialog.
     * @returns The trimmed input value, or null if cancelled / left empty.
     */
    async prompt(message: string, opts: { title?: string; defaultValue?: string; placeholder?: string; okText?: string; cancelText?: string } = {}): Promise<string | null> {
        const dialogRef = this.dialog.open(PromptDialogComponent, {
            data: {
                title: opts.title,
                message,
                defaultValue: opts.defaultValue,
                placeholder: opts.placeholder,
                okText: opts.okText,
                cancelText: opts.cancelText
            } as PromptDialogData,
            maxWidth: '500px'
        });

        return (await firstValueFrom(dialogRef.afterClosed())) ?? null;
    }

    /**
     * Opens an alert dialog with only an OK button.
     * @param message The message to display.
     * @param title Optional title for the dialog.
     * @param okText Optional text for the OK button.
     */
    async alert(message: string, title?: string, okText?: string): Promise<void> {
        const dialogRef = this.dialog.open(ConfirmDialogComponent, {
            data: {
                title,
                message,
                okText,
                isAlert: true
            } as ConfirmDialogData,
            maxWidth: '500px'
        });

        await firstValueFrom(dialogRef.afterClosed());
    }
}
