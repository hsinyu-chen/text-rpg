import { Component, effect, inject, signal, viewChild, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TextFieldModule } from '@angular/cdk/text-field';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { FileUpdate } from '@app/core/services/file-update.service';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { CacheManagerService } from '@app/core/services/cache-manager.service';
import { ConfirmDialogComponent, ConfirmDialogData } from '../confirm-dialog/confirm-dialog.component';
import { getLocale } from '@app/core/constants/locales';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { GroupedUpdate, HunkApplyController } from './hunk-apply-controller';

@Component({
  selector: 'app-auto-update-dialog',
  standalone: true,
  imports: [
    ...CORE_MAT,
    MatDialogModule,
    MatCheckboxModule,
    MatTabsModule,
    MatProgressSpinnerModule,
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
  private i18n = inject(I18nService);
  hunks = inject(HunkApplyController);

  private t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(`dialog.${key}`, params);
  }

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

  async onApply(): Promise<void> {
    const groups = this.hunks.groupedUpdates();
    const allSelected = groups.flatMap((g) => g.updates.filter((u) => u.selected()));
    if (allSelected.length === 0) {
      this.snackBar.open(this.t('noFilesToApply'), this.i18n.translate('ui.CLOSE'), { duration: 2000 });
      return;
    }

    const fileCount = groups.filter((g) => g.updates.some((u) => u.selected())).length;
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.t('applyAllChangesTitle'),
        message: this.t('applyAllChangesBody', { hunks: allSelected.length, files: fileCount }),
        okText: this.t('applyAllChangesBtn'),
        cancelText: this.t('cancel'),
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
      await this.cacheManager.clearAllServerCaches();
      this.dialogRef.close(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.snackBar.open(this.t('failedApplyUpdates', { error: message }), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
    } finally {
      this.isInitializing.set(false);
    }
  }

  /**
   * Apply changes for a single file only, then refresh that group.
   */
  async onApplyFile(group: GroupedUpdate): Promise<void> {
    if (!this.hunks.hasSelectedInGroup(group)) {
      this.snackBar.open(this.t('noHunksSelected'), this.i18n.translate('ui.CLOSE'), { duration: 2000 });
      return;
    }

    const selectedCount = group.updates.filter((u) => u.selected()).length;
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.t('applyCurrentFileTitle'),
        message: this.t('applyCurrentFileBody', { count: selectedCount, file: group.fileName }),
        okText: this.t('applyCurrentFileBtn'),
        cancelText: this.t('cancel'),
      } as ConfirmDialogData,
    });
    const confirmed = await firstValueFrom(dialogRef.afterClosed());
    if (!confirmed) return;

    this.isInitializing.set(true);
    try {
      await this.engine.updateSingleFile(group.fileName, group.combinedContent());
      await this.cacheManager.clearAllServerCaches();
      await this.hunks.refreshGroupAfterApply(group);
      this.snackBar.open(this.t('appliedToFile', { file: group.fileName }), this.i18n.translate('ui.CLOSE'), { duration: 2000 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.snackBar.open(this.t('failedApply', { error: message }), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
    } finally {
      this.isInitializing.set(false);
    }
  }
}
