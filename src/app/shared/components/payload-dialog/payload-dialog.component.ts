import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { FormsModule } from '@angular/forms';
import { MarkdownModule } from 'ngx-markdown';
import { Content, Part } from '@google/genai';

@Component({
  selector: 'app-payload-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, MatSlideToggleModule, FormsModule, MarkdownModule],
  templateUrl: './payload-dialog.component.html',
  styleUrl: './payload-dialog.component.scss'
})
export class PayloadDialogComponent {
  public dialogRef = inject<MatDialogRef<PayloadDialogComponent>>(MatDialogRef);
  public data = inject<Record<string, unknown>>(MAT_DIALOG_DATA);

  showKB = signal(false);

  get formattedPayload(): string {
    // Clone the entire data object
    const displayData = JSON.parse(JSON.stringify(this.data));

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
}
