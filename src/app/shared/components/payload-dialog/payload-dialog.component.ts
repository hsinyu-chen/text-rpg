import { Component, inject, signal } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTabsModule } from '@angular/material/tabs';
import { FormsModule } from '@angular/forms';
import { MarkdownModule } from 'ngx-markdown';
import { Content, Part } from '@google/genai';
import { TranslatePipe } from '@app/core/i18n';
import { CORE_MAT } from '@app/shared/material/material-groups';

@Component({
  selector: 'app-payload-dialog',
  standalone: true,
  imports: [...CORE_MAT, MatDialogModule, MatSlideToggleModule, MatTabsModule, FormsModule, MarkdownModule, TranslatePipe],
  templateUrl: './payload-dialog.component.html',
  styleUrl: './payload-dialog.component.scss'
})
export class PayloadDialogComponent {
  public dialogRef = inject<MatDialogRef<PayloadDialogComponent>>(MatDialogRef);
  public data = inject<Record<string, unknown>>(MAT_DIALOG_DATA);

  showKB = signal(false);

  get systemInstruction(): string {
    return (this.data['systemInstruction'] as string) || '';
  }

  get formattedPayload(): string {
    // Clone the entire data object
    const displayData = JSON.parse(JSON.stringify(this.data));

    // Remove systemInstruction from the JSON preview as it's displayed separately
    delete displayData.systemInstruction;

    // Hide KB content in contents if requested
    if (!this.showKB() && displayData.contents) {
      displayData.contents = displayData.contents.map((content: Content) => {
        if (content.parts) {
          content.parts = content.parts.map((part: Part) => {
            if (typeof part.text === 'string' && part.text.startsWith('--- 檔案內容')) {
              return { text: "... [Knowledge Base Content Hidden] ..." };
            }
            return part;
          });
        }
        return content;
      });
    }

    const json = JSON.stringify(displayData, null, 2);
    return '```json\n' + json + '\n```';
  }

  close() {
    this.dialogRef.close();
  }
}
