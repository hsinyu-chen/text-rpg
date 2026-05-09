import { Component, computed, inject } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { I18nService } from '@app/core/i18n';

export interface ConfirmDialogData {
  title?: string;
  message: string;
  okText?: string;
  cancelText?: string;
  isAlert?: boolean;
}

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule],
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss'
})
export class ConfirmDialogComponent {
  public dialogRef = inject<MatDialogRef<ConfirmDialogComponent>>(MatDialogRef);
  public data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
  private i18n = inject(I18nService);

  /** Translated default labels — caller-provided overrides win when present. */
  resolvedTitle = computed(() => this.data.title
    || this.i18n.translate(this.data.isAlert ? 'dialog.notificationTitle' : 'dialog.confirmTitle'));
  resolvedOkText = computed(() => this.data.okText || this.i18n.translate('dialog.ok'));
  resolvedCancelText = computed(() => this.data.cancelText || this.i18n.translate('dialog.cancel'));
}
