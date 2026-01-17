import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { GameStateService } from '../../../core/services/game-state.service';
import { getUIStrings } from '../../../core/constants/engine-protocol';
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
    template: `
        <div class="dialog-wrapper">
            <div class="dialog-header">
                <mat-icon>diff</mat-icon>
                <span class="title-text">{{ ui().PROMPT_UPDATE_TITLE || 'Prompt Update Comparison' }}: {{ data.label }}</span>
                <span class="spacer"></span>
                <button mat-icon-button (click)="onIgnore()" class="close-btn">
                    <mat-icon>close</mat-icon>
                </button>
            </div>

            <div class="dialog-body">
                <div class="editor-wrapper">
                    <app-monaco-editor
                        [isDiff]="true"
                        [originalValue]="data.remoteContent"
                        [(ngModel)]="data.localContent"
                        [language]="data.type === 'postprocess' ? 'javascript' : 'markdown'"
                        class="diff-editor">
                    </app-monaco-editor>
                </div>
            </div>

            <div class="dialog-footer">
                <button mat-button (click)="onIgnore()" color="warn">
                    {{ ui().IGNORE || 'Ignore' }}
                </button>
                <button mat-raised-button color="primary" (click)="onUpdate()">
                    {{ ui().UPDATE || 'Update' }}
                </button>
            </div>
        </div>
    `,
    styles: [`
        :host {
            display: block;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #1e1e1e;
        }

        .dialog-wrapper {
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
        }

        .dialog-header {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 16px;
            background: #252526;
            color: #ffffff;
            border-bottom: 1px solid #333;
            flex-shrink: 0;
        }

        .title-text {
            font-size: 1.1rem;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .spacer {
            flex: 1;
        }

        .dialog-body {
            flex: 1;
            position: relative;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            background: #1e1e1e;
        }

        .editor-wrapper {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            overflow: hidden;
        }

        .diff-editor {
            width: 100% !important;
            height: 100% !important;
            display: block;
        }

        .dialog-footer {
            display: flex;
            justify-content: flex-end;
            align-items: center;
            padding: 12px 16px;
            background: #252526;
            border-top: 1px solid #333;
            gap: 12px;
            flex-shrink: 0;
        }

        button[mat-raised-button] {
            min-width: 100px;
        }
    `]
})
export class PromptDiffDialogComponent {
    public dialogRef = inject(MatDialogRef<PromptDiffDialogComponent>);
    public data = inject<PromptDiffDialogData>(MAT_DIALOG_DATA);
    private state = inject(GameStateService);

    ui = computed(() => {
        const lang = this.state.config()?.outputLanguage || 'default';
        return getUIStrings(lang);
    });

    onUpdate() {
        this.dialogRef.close('update');
    }

    onIgnore() {
        this.dialogRef.close('ignore');
    }
}
