import { Component, Signal, WritableSignal, computed, inject, signal, viewChild, viewChildren } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { HunkListComponent } from '../hunk-list/hunk-list.component';
import { HunkListConfig, HunkSelection } from '../hunk-list/hunk-list.types';
import { FileUpdate, FileUpdateService } from '@app/core/services/file-update.service';
import { FileSystemService } from '@app/core/services/file-system.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { GameStateService } from '@app/core/services/game-state.service';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { ConfirmDialogComponent, ConfirmDialogData } from '../confirm-dialog/confirm-dialog.component';
import { GAME_INTENTS } from '@app/core/constants/game-intents';
import { getCoreFilenames } from '@app/core/constants/engine-protocol';
import { I18nService, TranslatePipe } from '@app/core/i18n';

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

/**
 * One file's editing state. The hunks + combined content are signals so a per-
 * group `<app-hunk-list>` can two-way bind them; `exists` is false for a file
 * the save is creating (its hunks render as "new" and never block apply).
 */
interface DialogGroup {
  fileName: string;
  originalContent: string;
  exists: boolean;
  hunks: WritableSignal<FileUpdate[]>;
  combined: WritableSignal<string>;
  /** Per-tab error dot, recomputed only when this group's hunks change. */
  hasMismatch: Signal<boolean>;
}

@Component({
  selector: 'app-auto-update-dialog',
  standalone: true,
  imports: [
    ...CORE_MAT,
    MatDialogModule,
    MatTabsModule,
    MatProgressSpinnerModule,
    FormsModule,
    MonacoEditorComponent,
    HunkListComponent,
    TranslatePipe,
  ],
  templateUrl: './auto-update-dialog.component.html',
  styleUrl: './auto-update-dialog.component.scss',
})
export class AutoUpdateDialogComponent {
  public dialogRef = inject<MatDialogRef<AutoUpdateDialogComponent>>(MatDialogRef);
  public data = inject<{ updates: FileUpdate[] }>(MAT_DIALOG_DATA);
  private appConfig = inject(AppConfigStore);
  private gameState = inject(GameStateService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private i18n = inject(I18nService);
  private fileUpdate = inject(FileUpdateService);
  private fileSystem = inject(FileSystemService);

  private t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(`dialog.${key}`, params);
  }

  groups = signal<DialogGroup[]>([]);
  activeIndex = signal(0);
  selection = signal<HunkSelection | null>(null);
  isInitializing = signal(true);
  isSidebarOpen = signal(true);

  private hunkLists = viewChildren(HunkListComponent);
  private monacoEditor = viewChild(MonacoEditorComponent);

  activeGroup = computed(() => this.groups()[this.activeIndex()] ?? null);

  /** Auto-update keeps every affordance; the new-feature flags stay off. */
  readonly hunkConfig: HunkListConfig = {
    autofixEnable: true,
    selectable: true,
    dragReorder: true,
    allowCreateFromSelection: false,
  };

  // A stats Book carries its closing values forward only on the "Apply & new act"
  // path (createNextBook re-folds the old act into the inherited ledger). Applying
  // to the current act would leave the next act resetting to the template baseline,
  // so that button is hard-disabled here.
  blockApplyCurrentForStats = computed(() => this.gameState.hasStatsYaml());

  hasSelectedUnresolvedError = computed(() => this.hunkLists().some((c) => c.hasSelectedUnresolvedError()));
  hasFixableErrors = computed(() => this.hunkLists().some((c) => c.hasFixableErrors()));
  hasSelectedUpdates = computed(() => this.hunkLists().some((c) => c.hasSelectedItems()));

  constructor() {
    void this.init();
  }

  toggleSidebar(): void {
    this.isSidebarOpen.update((v) => !v);
  }

  selectGroup(index: number): void {
    this.activeIndex.set(index);
  }

  onSelection(event: { text: string; startLineNumber: number; endLineNumber: number } | null): void {
    this.selection.set(event ? { text: event.text, startLineNumber: event.startLineNumber } : null);
  }

  onRevealLine(line: number): void {
    this.monacoEditor()?.revealLine(line);
  }

  private async init(): Promise<void> {
    const updates = [...this.data.updates];
    const lastSceneHunk = this.generateAutoLastSceneHunk(this.data.updates);
    if (lastSceneHunk) updates.push(lastSceneHunk);

    const map = new Map<string, FileUpdate[]>();
    for (const update of updates) {
      if (!map.has(update.filePath)) map.set(update.filePath, []);
      map.get(update.filePath)!.push(update);
    }

    const groups: DialogGroup[] = [];
    for (const [fileName, fileUpdates] of map) {
      let originalContent = '';
      let exists = true;
      try {
        originalContent = await this.fileSystem.readTextFile(fileName);
      } catch {
        exists = false;
      }
      const processed = this.fileUpdate.preprocessUpdates(fileUpdates, fileName, originalContent);

      // Pre-compose the applied result so the editor opens on it instead of
      // flashing the untouched file before <app-hunk-list>'s first recompute.
      let combined = originalContent;
      for (const update of processed) {
        combined = this.fileUpdate.applyUpdateToFile(combined, update);
      }

      const hunks = signal(processed);
      groups.push({
        fileName,
        originalContent,
        exists,
        hunks,
        combined: signal(combined),
        hasMismatch: computed(
          () => exists && hunks().some((h) => !this.fileUpdate.validateAgainstContent(originalContent, h).matched),
        ),
      });
    }

    this.groups.set(groups);
    this.isInitializing.set(false);
  }

  /**
   * Story Outline special case: if the save touched the outline, append a
   * synthetic hunk that records the latest story message as the new last_scene.
   */
  private generateAutoLastSceneHunk(seedUpdates: readonly FileUpdate[]): FileUpdate | null {
    const lang = this.appConfig.outputLanguage();
    const names = getCoreFilenames(lang);
    if (!seedUpdates.some((u) => u.filePath.includes(names.STORY_OUTLINE))) return null;

    const storyIntents = [GAME_INTENTS.ACTION, GAME_INTENTS.CONTINUE, GAME_INTENTS.FAST_FORWARD];
    const messages = this.gameState.messages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'model' && !msg.isRefOnly && msg.intent && (storyIntents as string[]).includes(msg.intent) && msg.content) {
        return this.fileUpdate.generateLastSceneHunk(msg.content, lang);
      }
    }
    return null;
  }

  onCancel(): void {
    this.dialogRef.close();
  }

  /** Repair every fixable hunk across all files, one group at a time. */
  async requestAutoFixAll(): Promise<void> {
    for (const list of this.hunkLists()) {
      await list.requestAutoFixAll();
    }
  }

  /** Each file with at least one selected hunk, with its fully-composed content. */
  private collectSelectedFiles(): AutoUpdateResult['files'] {
    const lists = this.hunkLists();
    return this.groups()
      .map((group, i) => ({ group, selected: lists[i]?.hasSelectedItems() ?? false }))
      .filter((x) => x.selected)
      .map((x) => ({ fileName: x.group.fileName, content: x.group.combined() }));
  }

  private countSelectedHunks(): number {
    return this.hunkLists().reduce((sum, list) => sum + list.selectedCount(), 0);
  }

  private async confirmAndClose(
    mode: AutoUpdateResult['mode'],
    titleKey: string,
    bodyKey: string,
    btnKey: string,
  ): Promise<void> {
    // Backstop for the disabled apply buttons — also blocks any programmatic
    // path that reaches here with a selected-but-unresolved hunk.
    if (this.hasSelectedUnresolvedError()) {
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
    // Backstop for the disabled button — a stats Book must advance via a new act
    // so its closing values carry forward; applying to the current act would reset.
    if (this.blockApplyCurrentForStats()) {
      this.snackBar.open(this.t('applyToActStatsBlocked'), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
      return Promise.resolve();
    }
    return this.confirmAndClose('current', 'applyToActTitle', 'applyToActBody', 'applyToActBtn');
  }

  /** Apply selected hunks into a freshly-created NEXT act, then init it; the current act stays replayable. */
  onApplyNewAct(): Promise<void> {
    return this.confirmAndClose('newAct', 'applyNewActTitle', 'applyNewActBody', 'applyNewActBtn');
  }
}
