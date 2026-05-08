import {
  Injectable,
  WritableSignal,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FileUpdate, FileUpdateService } from '@app/core/services/file-update.service';
import { FileSystemService } from '@app/core/services/file-system.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { GAME_INTENTS } from '@app/core/constants/game-intents';
import { getCoreFilenames } from '@app/core/constants/engine-protocol';
import { ConfirmDialogComponent, ConfirmDialogData } from '../confirm-dialog/confirm-dialog.component';
import { I18nService } from '@app/core/i18n';

export interface ValidationStatus {
  exists: boolean;
  matched: boolean;
  validating: boolean;
  alreadyExists?: boolean;
  beforeLines?: string[];
  afterLines?: string[];
  matchIndex?: number;
  failReason?: 'target_not_found' | 'context_mismatch';
}

export type MonacoUpdateItem = FileUpdate & {
  id: string;
  selected: WritableSignal<boolean>;
  status?: ValidationStatus;
};

export interface GroupedUpdate {
  fileName: string;
  updates: MonacoUpdateItem[];
  originalContent: WritableSignal<string>;
  combinedContent: WritableSignal<string>;
  computedContent: WritableSignal<string>;
}

export interface HunkApplyHost {
  /** Scroll the editor to the line that holds the active hunk's target/context. */
  scrollEditorTo(lineNumber: number): void;
}

/**
 * In-memory hunk pipeline extracted from AutoUpdateDialog.
 *
 * Owns: grouping of FileUpdate[] by file path, per-hunk validation/calibration
 * state, the recomputed-on-every-edit `combinedContent`, drag-reorder, and
 * the calibration state machine (selection-anchored target+context inference).
 *
 * Does NOT own: editor instance, file writes, dialog ref, regenerate-save
 * prompt assembly. Provided in the dialog's `providers` array (per-instance).
 */
@Injectable()
export class HunkApplyController {
  private updateService = inject(FileUpdateService);
  private fileSystem = inject(FileSystemService);
  private state = inject(GameStateService);
  private appConfig = inject(AppConfigStore);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private i18n = inject(I18nService);

  private t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(`dialog.${key}`, params);
  }

  groupedUpdates = signal<GroupedUpdate[]>([]);
  activeGroupIndex = signal(0);
  activeUpdate = signal<MonacoUpdateItem | null>(null);
  filesLoaded = signal(false);
  /** True once the initial groupUpdates pass has run (success or error). */
  groupingComplete = signal(false);
  calibratingUpdateId = signal<string | null>(null);
  currentSelection = signal<{ text: string; startLineNumber: number } | null>(null);

  activeGroup = computed(() => this.groupedUpdates()[this.activeGroupIndex()] || null);

  private host?: HunkApplyHost;

  constructor() {
    // Trigger validation when grouping completes.
    effect(() => {
      if (this.filesLoaded()) {
        untracked(() => void this.validateAll());
      }
    });

    // Real-time preview: recompute combinedContent ONLY while a hunk is being
    // calibrated. recomputeCombinedContent reads currentSelection() itself
    // and applies an on-the-fly tempUpdate for the calibrating hunk, leaving
    // the source array untouched. Outside calibration, a recompute on every
    // cursor move would silently overwrite the user's manual edits.
    effect(() => {
      this.currentSelection();
      const calibratingId = this.calibratingUpdateId();
      if (!calibratingId) return;
      untracked(() => {
        const group = this.activeGroup();
        if (group) this.recomputeCombinedContent(group);
      });
    });
  }

  bind(host: HunkApplyHost): void {
    this.host = host;
  }

  /** Initialise from the dialog's seed updates and kick off the initial group pass. */
  init(seedUpdates: readonly FileUpdate[]): void {
    const updates = [...seedUpdates];
    const lastSceneHunk = this.generateAutoLastSceneHunk(seedUpdates);
    if (lastSceneHunk) updates.push(lastSceneHunk);
    void this.groupUpdates(updates);
  }

  selectGroup(index: number): void {
    this.activeGroupIndex.set(index);
    const group = this.groupedUpdates()[index];
    if (group && group.updates.length > 0) {
      this.activeUpdate.set(group.updates[0]);
    }
  }

  selectUpdate(update: MonacoUpdateItem): void {
    this.activeUpdate.set(update);
    this.scrollToHunk(update);
  }

  hasMismatch(group: GroupedUpdate): boolean {
    return group.updates.some((u) => u.status && u.status.exists && !u.status.matched);
  }

  hasAnyMismatch(): boolean {
    return this.groupedUpdates().some((g) => this.hasMismatch(g));
  }

  hasSelectedUpdates(): boolean {
    return this.groupedUpdates().some((g) => g.updates.some((u) => u.selected()));
  }

  hasSelectedInGroup(group: GroupedUpdate): boolean {
    return group.updates.some((u) => u.selected());
  }

  async onCheckboxClick(group: GroupedUpdate, update: MonacoUpdateItem, event: Event): Promise<void> {
    event.stopPropagation();
    const targetChecked = !update.selected();
    if (await this.confirmDiscardIfDirty(group, this.t('confirmDiscardSelections'), this.t('discardUpdate'))) {
      update.selected.set(targetChecked);
      this.recomputeCombinedContent(group);
    }
  }

  async onDrop(group: GroupedUpdate, event: CdkDragDrop<MonacoUpdateItem[]>): Promise<void> {
    if (event.previousIndex === event.currentIndex) return;
    if (await this.confirmDiscardIfDirty(group, this.t('confirmDiscardReorder'), this.t('discardReorder'))) {
      moveItemInArray(group.updates, event.previousIndex, event.currentIndex);
      this.recomputeCombinedContent(group);
      this.groupedUpdates.update((groups) => [...groups]);
    }
  }

  onMonacoSelectionChange(event: { text: string; startLineNumber: number } | null): void {
    this.currentSelection.set(event);
  }

  async startCalibration(update: MonacoUpdateItem): Promise<void> {
    // Calibration's effect overwrites combinedContent on every selection
    // change — manual edits would silently disappear without a confirm.
    const group = this.activeGroup();
    if (group && !(await this.confirmDiscardIfDirty(group, this.t('confirmDiscardCalibrate'), this.t('discardCalibrate')))) {
      return;
    }
    this.calibratingUpdateId.set(update.id);
    this.currentSelection.set(null);
    this.selectUpdate(update);
  }

  cancelCalibration(): void {
    this.calibratingUpdateId.set(null);
    this.currentSelection.set(null);
  }

  async applyCalibration(update: MonacoUpdateItem): Promise<void> {
    const selection = this.currentSelection();
    const group = this.activeGroup();
    if (!selection || !group) return;

    update.targetContent = selection.text;
    // selection.startLineNumber is 1-indexed from Monaco, inferContextFromLine expects 0-indexed
    update.context = this.updateService.inferContextFromLine(group.originalContent(), selection.startLineNumber - 1);

    this.cancelCalibration();
    await this.revalidateUpdate(update, group);
    this.snackBar.open(this.t('calibrationSuccess'), this.i18n.translate('ui.CLOSE'), { duration: 2000 });
  }

  onHunkContentChange(update: MonacoUpdateItem, type: 'target' | 'replacement', event: Event): void {
    const newVal = (event.target as HTMLTextAreaElement).value;
    const group = this.activeGroup();
    if (!group) return;

    if (type === 'target') update.targetContent = newVal;
    else update.replacementContent = newVal;

    void this.revalidateUpdate(update, group);
  }

  /**
   * Refresh validation + originalContent on a group whose contents were just
   * written to disk. Used by the dialog's onApplyFile flow. Only re-validates
   * this group — flashing spinners on untouched files would be misleading.
   */
  async refreshGroupAfterApply(group: GroupedUpdate): Promise<void> {
    group.originalContent.set(group.combinedContent());
    group.computedContent.set(group.combinedContent());
    for (const update of group.updates) {
      update.status = { exists: false, matched: false, validating: true };
    }
    this.groupedUpdates.update((groups) => [...groups]);
    await this.validateGroup(group);
  }

  private async confirmDiscardIfDirty(group: GroupedUpdate, message: string, okText: string): Promise<boolean> {
    if (group.combinedContent() === group.computedContent()) return true;

    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.t('discardEditsTitle'),
        message,
        okText,
        cancelText: this.t('cancel'),
      } as ConfirmDialogData,
    });
    return !!(await firstValueFrom(dialogRef.afterClosed()));
  }

  private generateAutoLastSceneHunk(seedUpdates: readonly FileUpdate[]): FileUpdate | null {
    const lang = this.appConfig.outputLanguage();
    const names = getCoreFilenames(lang);
    const hasPlotOutlineUpdate = seedUpdates.some((u) => u.filePath.includes(names.STORY_OUTLINE));
    if (!hasPlotOutlineUpdate) return null;

    const storyIntents = [GAME_INTENTS.ACTION, GAME_INTENTS.CONTINUE, GAME_INTENTS.FAST_FORWARD];
    const messages = this.state.messages();

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'model' && !msg.isRefOnly && msg.intent && (storyIntents as string[]).includes(msg.intent) && msg.content) {
        console.log('[AutoUpdateDialog] Found last story message for last_scene:', msg.id);
        return this.updateService.generateLastSceneHunk(msg.content, lang);
      }
    }

    console.warn('[AutoUpdateDialog] No story-type model message found for last_scene generation.');
    return null;
  }

  private async groupUpdates(fileUpdates: readonly FileUpdate[]): Promise<void> {
    this.filesLoaded.set(false);

    let counter = 0;
    const map = new Map<string, MonacoUpdateItem[]>();

    for (const update of fileUpdates) {
      if (!map.has(update.filePath)) map.set(update.filePath, []);
      map.get(update.filePath)!.push({
        ...update,
        id: `upd_${counter++}`,
        selected: signal(true),
        status: { exists: false, matched: false, validating: true },
      });
    }

    try {
      const groups: GroupedUpdate[] = [];
      for (const [fileName, updates] of map.entries()) {
        let originalContent = '';
        try {
          originalContent = await this.fileSystem.readTextFile(fileName);
        } catch (e: unknown) {
          console.warn(`File ${fileName} not found for combined view:`, e);
        }

        const rawProcessedUpdates = this.updateService.preprocessUpdates(updates, fileName, originalContent);
        const processedUpdates: MonacoUpdateItem[] = rawProcessedUpdates.map((u) => {
          const updateItem = u as Partial<MonacoUpdateItem>;
          const isSignal = updateItem.selected && typeof updateItem.selected === 'function' && 'set' in updateItem.selected;
          return {
            ...u,
            id: updateItem.id || `upd_${counter++}`,
            selected: isSignal ? (updateItem.selected as WritableSignal<boolean>) : signal(true),
            status: updateItem.status || { exists: false, matched: false, validating: true },
          };
        });

        const group: GroupedUpdate = {
          fileName,
          updates: processedUpdates,
          originalContent: signal(originalContent),
          combinedContent: signal(''),
          computedContent: signal(''),
        };
        this.recomputeCombinedContent(group);
        groups.push(group);
      }

      this.groupedUpdates.set(groups);

      if (groups.length > 0 && groups[0].updates.length > 0) {
        this.selectUpdate(groups[0].updates[0]);
      }

      this.filesLoaded.set(true);
    } catch (err) {
      console.error('[AutoUpdateDialog] Error grouping updates:', err);
      this.snackBar.open('Error processing updates', 'Close');
    } finally {
      this.groupingComplete.set(true);
    }
  }

  recomputeCombinedContent(group: GroupedUpdate): void {
    // For the calibrating hunk we apply a synthetic tempUpdate built from the
    // live selection — the source array is left untouched so cancel reverts
    // for free, indexOf-based lookups stay valid, and OnPush consumers don't
    // see false reference changes. Only applyCalibration() commits the values
    // back onto the hunk permanently.
    const calibratingId = this.calibratingUpdateId();
    const selection = this.currentSelection();
    let result = group.originalContent();

    for (const update of group.updates) {
      if (!update.selected()) continue;
      if (update.id === calibratingId && selection) {
        const tempContext = this.updateService.inferContextFromLine(group.originalContent(), selection.startLineNumber - 1);
        result = this.updateService.applyUpdateToFile(result, { ...update, targetContent: selection.text, context: tempContext });
      } else {
        result = this.updateService.applyUpdateToFile(result, update);
      }
    }
    group.computedContent.set(result);
    group.combinedContent.set(result);
  }

  private async validateAll(): Promise<void> {
    for (const group of this.groupedUpdates()) {
      await this.validateGroup(group);
    }
  }

  private async validateGroup(group: GroupedUpdate): Promise<void> {
    for (let i = 0; i < group.updates.length; i++) {
      const update = group.updates[i];
      const replacement = await this.runValidation(update);
      group.updates[i] = replacement;
      if (this.activeUpdate()?.id === update.id) {
        this.activeUpdate.set(replacement);
      }
      // Per-hunk refresh so the validating spinner clears progressively
      // as each hunk completes — gives the user feedback on long passes.
      this.groupedUpdates.update((groups) => [...groups]);
    }
  }

  private async revalidateUpdate(update: MonacoUpdateItem, group: GroupedUpdate): Promise<void> {
    const idx = group.updates.indexOf(update);
    if (idx < 0) return;

    // Mark validating via in-place + array swap to fire change detection
    // without breaking referential equality at the array level.
    group.updates[idx] = { ...update, status: { ...update.status!, validating: true } };
    if (this.activeUpdate()?.id === update.id) this.activeUpdate.set(group.updates[idx]);
    this.groupedUpdates.update((groups) => [...groups]);

    const replacement = await this.runValidation(group.updates[idx]);
    group.updates[idx] = replacement;
    this.recomputeCombinedContent(group);
    if (this.activeUpdate()?.id === replacement.id) this.activeUpdate.set(replacement);
    this.groupedUpdates.update((groups) => [...groups]);
  }

  /**
   * Run one validateUpdate cycle against an item, returning a fresh object
   * with the resolved status. Same shape used by validateGroup and
   * revalidateUpdate so the array element is always replaced — never mutated
   * in place — keeping referential equality consistent for downstream signals.
   */
  private async runValidation(update: MonacoUpdateItem): Promise<MonacoUpdateItem> {
    try {
      const result = await this.updateService.validateUpdate(update);
      return {
        ...update,
        status: {
          exists: result.exists,
          matched: result.matched,
          alreadyExists: result.alreadyExists,
          beforeLines: result.beforeLines,
          afterLines: result.afterLines,
          matchIndex: result.matchIndex,
          failReason: result.failReason,
          validating: false,
        },
      };
    } catch (err) {
      console.error(`[AutoUpdateDialog] Validation failed for ${update.id}`, err);
      return { ...update, status: { ...update.status!, validating: false } };
    }
  }

  /** Compute the line number to scroll to for a given hunk; null if no anchor found. */
  private scrollLineForHunk(group: GroupedUpdate, update: MonacoUpdateItem): number | null {
    const searchContent = update.replacementContent || update.targetContent;
    if (!searchContent) return null;

    const combinedContentStr = group.combinedContent();
    const range = this.updateService.findMatchRange(combinedContentStr, searchContent, update.context);
    if (range) {
      return combinedContentStr.substring(0, range.start).split(/\r?\n/).length;
    }
    if (update.context) {
      const contextLine = this.updateService.findContextLine(combinedContentStr, update.context);
      // findContextLine returns 0-indexed, Monaco expects 1-indexed
      if (contextLine !== null) return contextLine + 1;
    }
    return null;
  }

  private scrollToHunk(update: MonacoUpdateItem): void {
    const group = this.activeGroup();
    if (!group || !this.host) return;
    const line = this.scrollLineForHunk(group, update);
    if (line !== null) {
      // Small delay to ensure editor is ready after tab switch
      setTimeout(() => this.host?.scrollEditorTo(line), 50);
    }
  }
}
