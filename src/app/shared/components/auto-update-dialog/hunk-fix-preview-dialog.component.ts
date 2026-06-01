import { Component, inject } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { I18nService, TranslatePipe } from '@app/core/i18n';

export interface HunkFixPreviewData {
    oldTarget: string;
    newTarget: string;
    oldReplacement: string;
    newReplacement: string;
    oldContext: string[];
    newContext: string[];
}

interface DiffRow {
    titleKey: string;
    old: string;
    new: string;
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
    private i18n = inject(I18nService);
    readonly data = inject<HunkFixPreviewData>(MAT_DIALOG_DATA);

    /** The three old→new rows (context / target / replacement) share one layout. */
    readonly rows: DiffRow[] = [
        { titleKey: 'dialog.autoFixContextLabel', old: this.contextDisplay(this.data.oldContext), new: this.contextDisplay(this.data.newContext) },
        { titleKey: 'dialog.targetLabel', old: this.orEmpty(this.data.oldTarget), new: this.orEmpty(this.data.newTarget) },
        { titleKey: 'dialog.replacementLabel', old: this.orEmpty(this.data.oldReplacement), new: this.orEmpty(this.data.newReplacement) },
    ];

    /** A context path joined for display, or the file-root label when empty. */
    private contextDisplay(context: string[]): string {
        return context.length ? context.join(' > ') : this.i18n.translate('dialog.hunkRootContext');
    }

    private orEmpty(value: string): string {
        return value || this.i18n.translate('dialog.autoFixEmptyPlaceholder');
    }

    confirm(): void { this.dialogRef.close(true); }
    cancel(): void { this.dialogRef.close(false); }
}
