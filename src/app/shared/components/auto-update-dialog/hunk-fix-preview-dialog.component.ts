import { Component, inject } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslatePipe } from '@app/core/i18n';

export interface HunkFixPreviewData {
    oldTarget: string;
    newTarget: string;
    oldReplacement: string;
    newReplacement: string;
}

/**
 * Shows the LLM's proposed repair (old → new for both target and replacement)
 * before we mutate the hunk. Confirm/cancel ⇒ boolean closes back to the
 * controller. Kept separate from `ConfirmDialogComponent` so the diff layout
 * doesn't need to bend the generic confirm shape.
 */
@Component({
    selector: 'app-hunk-fix-preview-dialog',
    standalone: true,
    imports: [MatDialogModule, MatButtonModule, MatIconModule, TranslatePipe],
    templateUrl: './hunk-fix-preview-dialog.component.html',
    styleUrl: './hunk-fix-preview-dialog.component.scss',
})
export class HunkFixPreviewDialogComponent {
    private dialogRef = inject<MatDialogRef<HunkFixPreviewDialogComponent, boolean>>(MatDialogRef);
    readonly data = inject<HunkFixPreviewData>(MAT_DIALOG_DATA);

    confirm(): void { this.dialogRef.close(true); }
    cancel(): void { this.dialogRef.close(false); }
}
