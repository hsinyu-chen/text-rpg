import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';

export interface SaveNameDialogData {
    title: string;
    initialName: string;
    placeholder?: string;
}

@Component({
    selector: 'app-save-name-dialog',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatDialogModule,
        MatButtonModule,
        MatInputModule,
        MatFormFieldModule
    ],
    template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <mat-form-field class="full-width">
        <mat-label>Save Name</mat-label>
        <input matInput [(ngModel)]="saveName" [placeholder]="data.placeholder || 'Enter save name'" 
               (keydown.enter)="saveName.trim() && onSave()" cdkFocusInitial>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-flat-button color="primary" [disabled]="!saveName.trim()" (click)="onSave()">Save</button>
    </mat-dialog-actions>
  `,
    styles: [`
    .full-width {
      width: 100%;
      margin-top: 8px;
    }
    :host {
        display: block;
        min-width: 350px;
    }
  `]
})
export class SaveNameDialogComponent {
    public data = inject<SaveNameDialogData>(MAT_DIALOG_DATA);
    private dialogRef = inject(MatDialogRef<SaveNameDialogComponent>);

    saveName = this.data.initialName || '';

    onSave() {
        if (this.saveName.trim()) {
            this.dialogRef.close(this.saveName.trim());
        }
    }

    onCancel() {
        this.dialogRef.close();
    }
}
