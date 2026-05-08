import { Component, effect, inject, signal, viewChild, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TextFieldModule } from '@angular/cdk/text-field';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { FileUpdate } from '@app/core/services/file-update.service';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { CommonModule } from '@angular/common';
import { CacheManagerService } from '@app/core/services/cache-manager.service';
import { ConfirmDialogComponent, ConfirmDialogData } from '../confirm-dialog/confirm-dialog.component';
import { GAME_INTENTS } from '@app/core/constants/game-intents';
import { getLocale } from '@app/core/constants/locales';
import { TranslatePipe } from '@app/core/i18n';
import { GroupedUpdate, HunkApplyController } from './hunk-apply-controller';
import { buildRegenerateSavePrompt } from './regenerate-save.util';

@Component({
  selector: 'app-auto-update-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatCheckboxModule,
    MatTabsModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    TextFieldModule,
    DragDropModule,
    FormsModule,
    MonacoEditorComponent,
    TranslatePipe
  ],
  templateUrl: './auto-update-dialog.component.html',
  styleUrl: './auto-update-dialog.component.scss',
  providers: [HunkApplyController]
})
export class AutoUpdateDialogComponent {
  public dialogRef = inject<MatDialogRef<AutoUpdateDialogComponent>>(MatDialogRef);
  public data = inject<{ updates: FileUpdate[] }>(MAT_DIALOG_DATA);
  private engine = inject(GameEngineService);
  private appConfig = inject(AppConfigStore);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private cacheManager = inject(CacheManagerService);
  hunks = inject(HunkApplyController);

  isInitializing = signal(true);
  isSidebarOpen = signal(true); // Controls left panel visibility on mobile

  private monacoEditor = viewChild(MonacoEditorComponent);

  locale = computed(() => getLocale(this.appConfig.outputLanguage()));

  constructor() {
    this.hunks.bind({
      scrollEditorTo: (lineNumber) => this.monacoEditor()?.revealLine(lineNumber),
    });
    this.hunks.init(this.data.updates);
    // Drop the loading spinner once the first groupUpdates() pass settles —
    // success or error. validateAll runs lazily after this and fills per-hunk
    // status spinners independently.
    effect(() => {
      if (this.hunks.groupingComplete()) this.isInitializing.set(false);
    });
  }

  toggleSidebar(): void {
    this.isSidebarOpen.update((v) => !v);
  }

  onCancel(): void {
    this.dialogRef.close();
  }

  /**
   * Generate a prompt to ask LLM to regenerate save with failed items.
   * Closes the dialog and sends the message.
   */
  onRegenerateSave(): void {
    const message = buildRegenerateSavePrompt(this.hunks.groupedUpdates(), this.locale());
    void this.engine.sendMessage(message, { intent: GAME_INTENTS.SAVE });
    this.dialogRef.close();
  }

  async onApply(): Promise<void> {
    const groups = this.hunks.groupedUpdates();
    const allSelected = groups.flatMap((g) => g.updates.filter((u) => u.selected()));
    if (allSelected.length === 0) {
      this.snackBar.open('No files to apply', 'Close', { duration: 2000 });
      return;
    }

    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: 'Apply All Changes',
        message: `Apply changes to ${allSelected.length} hunk(s) across ${groups.filter((g) => g.updates.some((u) => u.selected())).length} file(s)?`,
        okText: 'Apply All',
        cancelText: 'Cancel',
      } as ConfirmDialogData,
    });
    const confirmed = await firstValueFrom(dialogRef.afterClosed());
    if (!confirmed) return;

    this.isInitializing.set(true);
    try {
      for (const group of groups) {
        if (group.updates.some((u) => u.selected())) {
          await this.engine.updateSingleFile(group.fileName, group.combinedContent());
        }
      }
      // [Added] Clear remote cache since files have changed
      await this.cacheManager.clearAllServerCaches();
      this.dialogRef.close(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.snackBar.open('Failed to apply updates: ' + message, 'Close', { duration: 3000 });
    } finally {
      this.isInitializing.set(false);
    }
  }

  /**
   * Apply changes for a single file only, then refresh that group.
   */
  async onApplyFile(group: GroupedUpdate): Promise<void> {
    if (!this.hunks.hasSelectedInGroup(group)) {
      this.snackBar.open('No hunks selected for this file', 'Close', { duration: 2000 });
      return;
    }

    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: 'Apply Changes to Current File',
        message: `Apply ${group.updates.filter((u) => u.selected()).length} selected hunk(s) to "${group.fileName}"?`,
        okText: 'Apply',
        cancelText: 'Cancel',
      } as ConfirmDialogData,
    });
    const confirmed = await firstValueFrom(dialogRef.afterClosed());
    if (!confirmed) return;

    this.isInitializing.set(true);
    try {
      await this.engine.updateSingleFile(group.fileName, group.combinedContent());
      // [Added] Clear remote cache since files have changed
      await this.cacheManager.clearAllServerCaches();
      await this.hunks.refreshGroupAfterApply(group);
      this.snackBar.open(`Applied changes to ${group.fileName}`, 'OK', { duration: 2000 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.snackBar.open('Failed to apply: ' + message, 'Close', { duration: 3000 });
    } finally {
      this.isInitializing.set(false);
    }
  }
}
