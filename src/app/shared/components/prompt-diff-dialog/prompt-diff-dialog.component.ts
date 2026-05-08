import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { getUIStrings } from '@app/core/constants/engine-protocol';
import { FormsModule } from '@angular/forms';

export interface PromptDiffDialogData {
    type: 'action' | 'continue' | 'fastforward' | 'system' | 'save' | 'postprocess';
    localContent: string;
    remoteContent: string;
    label: string;
}

@Component({
    selector: 'app-prompt-diff-dialog',
    standalone: true,
    imports: [
        CommonModule,
        MatDialogModule,
        MatButtonModule,
        MatIconModule,
        FormsModule,
        MonacoEditorComponent
    ],
    templateUrl: './prompt-diff-dialog.component.html',
    styleUrl: './prompt-diff-dialog.component.scss'
})
export class PromptDiffDialogComponent {
    public dialogRef = inject(MatDialogRef<PromptDiffDialogComponent>);
    public data = inject<PromptDiffDialogData>(MAT_DIALOG_DATA);
    private appConfig = inject(AppConfigStore);

    ui = computed(() => getUIStrings(this.appConfig.outputLanguage()));

    onUpdate() {
        this.dialogRef.close('update');
    }

    onIgnore() {
        this.dialogRef.close('ignore');
    }
}
