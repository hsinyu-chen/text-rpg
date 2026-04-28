import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Clipboard } from '@angular/cdk/clipboard';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';

export type S3JsonDialogMode = 'import' | 'export';

export interface S3ConfigJsonDialogData {
    mode: S3JsonDialogMode;
    /** For export: the JSON string to display. */
    initial?: string;
}

@Component({
    selector: 'app-s3-config-json-dialog',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatDialogModule,
        MatButtonModule,
        MatFormFieldModule,
        MatInputModule,
        MatIconModule
    ],
    templateUrl: './s3-config-json-dialog.component.html',
    styleUrl: './s3-config-json-dialog.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class S3ConfigJsonDialogComponent {
    dialogRef = inject(MatDialogRef<S3ConfigJsonDialogComponent, string | undefined>);
    data = inject<S3ConfigJsonDialogData>(MAT_DIALOG_DATA);
    private snackBar = inject(MatSnackBar);
    private clipboard = inject(Clipboard);

    text = signal(this.data.initial ?? '');

    get isExport(): boolean { return this.data.mode === 'export'; }

    cancel(): void {
        this.dialogRef.close(undefined);
    }

    save(): void {
        const trimmed = this.text().trim();
        if (!trimmed) return;
        this.dialogRef.close(trimmed);
    }

    copy(): void {
        const ok = this.clipboard.copy(this.text());
        if (ok) {
            this.snackBar.open('Copied to clipboard.', 'OK', { duration: 2000 });
        } else {
            this.snackBar.open('Copy failed; select text manually.', 'Close', { duration: 3000 });
        }
    }
}
