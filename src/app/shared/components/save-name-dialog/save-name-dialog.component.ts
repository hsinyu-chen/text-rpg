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
  inputType?: string;
  min?: number;
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
  templateUrl: './save-name-dialog.component.html',
  styleUrl: './save-name-dialog.component.scss'
})
export class SaveNameDialogComponent {
  public data = inject<SaveNameDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<SaveNameDialogComponent>);

  saveName = this.data.initialName || '';

  isValid() {
    const val = this.saveName.toString().trim();
    if (!val) return false;
    if (this.data.inputType === 'number' && this.data.min !== undefined) {
      return Number(val) >= this.data.min;
    }
    return true;
  }

  onSave() {
    if (this.isValid()) {
      this.dialogRef.close(this.saveName.toString().trim());
    }
  }

  onCancel() {
    this.dialogRef.close();
  }
}
