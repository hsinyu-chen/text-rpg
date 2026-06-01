import { Component, effect, inject, signal, viewChild, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Clipboard } from '@angular/cdk/clipboard';
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
import { AppConfigStore } from '@app/core/services/app-config-store';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { ConfirmDialogComponent, ConfirmDialogData } from '../confirm-dialog/confirm-dialog.component';
import { getLocale } from '@app/core/constants/locales';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { HunkApplyController, MonacoUpdateItem } from './hunk-apply-controller';
import { HunkAutoFixService } from './hunk-auto-fix.service';

/**
 * Dialog close payload. The dialog stays pure UI — it composes the per-file
 * content from the selected hunks and hands it back; the save orchestrator
 * does the actual writing + trace + lock + new-act. `mode` decides whether the
 * apply lands on the current act's KB or a freshly-created next act.
 */
export interface AutoUpdateResult {
  mode: 'current' | 'newAct';
  files: { fileName: string; content: string }[];
}

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
  providers: [HunkApplyController, HunkAutoFixService]
})
export class AutoUpdateDialogComponent {
  public dialogRef = inject<MatDialogRef<AutoUpdateDialogComponent>>(MatDialogRef);
  public data = inject<{ updates: FileUpdate[] }>(MAT_DIALOG_DATA);
  private appConfig = inject(AppConfigStore);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private clipboard = inject(Clipboard);
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

  /**
   * Copy the raw hunk payload (file / context / target / replacement) as JSON
   * to the clipboard. UI-only fields (signals, validation status, autoFix
   * counters, line / preview slices) are stripped — what gets copied matches
   * the on-the-wire hunk shape so it can be pasted back into a manifest /
   * issue / debug log.
   */
  copyHunkRaw(update: MonacoUpdateItem): void {
    const payload = {
      file: update.filePath,
      context: update.context ?? [],
      ...(update.targetContent !== undefined ? { target: update.targetContent } : {}),
      replacement: update.replacementContent ?? '',
    };
    const ok = this.clipboard.copy(JSON.stringify(payload, null, 2));
    this.snackBar.open(
      this.t(ok ? 'hunkRawCopied' : 'hunkRawCopyFailed'),
      this.i18n.translate('ui.CLOSE'),
      { duration: 2000 },
    );
  }

  onCancel(): void {
    this.dialogRef.close();
  }

  /**
   * Per file with at least one selected hunk, the fully-composed content.
   * `combinedContent` already reflects selection + manual edits + calibration,
   * so this is a plain read — the dialog never writes; the close result hands
   * these to the save orchestrator, which owns apply / trace / lock / new-act.
   */
  private collectSelectedFiles(): AutoUpdateResult['files'] {
    return this.hunks
      .groupedUpdates()
      .filter((g) => g.updates.some((u) => u.selected()))
      .map((g) => ({ fileName: g.fileName, content: g.combinedContent() }));
  }

  private countSelectedHunks(): number {
    return this.hunks
      .groupedUpdates()
      .reduce((sum, g) => sum + g.updates.filter((u) => u.selected()).length, 0);
  }

  private async confirmAndClose(mode: AutoUpdateResult['mode'], titleKey: string, bodyKey: string, btnKey: string): Promise<void> {
    // Backstop for the disabled apply buttons — also blocks any programmatic
    // path that reaches here with a selected-but-unresolved hunk.
    if (this.hunks.hasSelectedUnresolvedError()) {
      this.snackBar.open(this.t('saveBlockedUnresolved'), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
      return;
    }
    const files = this.collectSelectedFiles();
    if (files.length === 0) {
      this.snackBar.open(this.t('noFilesToApply'), this.i18n.translate('ui.CLOSE'), { duration: 2000 });
      return;
    }
    const confirmed = await firstValueFrom(
      this.dialog.open(ConfirmDialogComponent, {
        data: {
          title: this.t(titleKey),
          message: this.t(bodyKey, { hunks: this.countSelectedHunks(), files: files.length }),
          okText: this.t(btnKey),
          cancelText: this.t('cancel'),
        } as ConfirmDialogData,
      }).afterClosed(),
    );
    if (!confirmed) return;
    this.dialogRef.close({ mode, files } satisfies AutoUpdateResult);
  }

  /** Apply selected hunks to the CURRENT act's KB (leaves a chat trace + locks new turns). */
  onApplyCurrent(): Promise<void> {
    return this.confirmAndClose('current', 'applyToActTitle', 'applyToActBody', 'applyToActBtn');
  }

  /** Apply selected hunks into a freshly-created NEXT act, then init it; the current act stays replayable. */
  onApplyNewAct(): Promise<void> {
    return this.confirmAndClose('newAct', 'applyNewActTitle', 'applyNewActBody', 'applyNewActBtn');
  }
}
