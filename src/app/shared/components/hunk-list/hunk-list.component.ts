import {
  Component,
  computed,
  contentChild,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TextFieldModule } from '@angular/cdk/text-field';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';

import { FileUpdate, ValidationResult } from '@app/core/services/file-update.service';
import { FileUpdateService } from '@app/core/services/file-update.service';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { ConfirmDialogComponent, ConfirmDialogData } from '../confirm-dialog/confirm-dialog.component';
import { HunkAutoFixService } from '../auto-update-dialog/hunk-auto-fix.service';
import {
  HunkAutoFixProgressDialogComponent,
  HunkAutoFixProgressData,
} from '../auto-update-dialog/hunk-auto-fix-progress-dialog.component';
import {
  HunkFixPreviewDialogComponent,
  HunkFixPreviewData,
} from '../auto-update-dialog/hunk-fix-preview-dialog.component';
import { HunkItem, HunkListConfig, HunkSelection } from './hunk-list.types';
import { HunkCalibrateContext, HunkCalibrateDirective } from './hunk-calibrate.directive';

/**
 * Consecutive LLM repair attempts on a single hunk allowed before the button
 * hides — "this isn't going to work, stop burning tokens".
 */
const MAX_AUTO_FIX_ATTEMPTS = 3;

type AutoFixOutcome = 'applied' | 'idempotent' | 'unmatched' | 'failed' | 'aborted' | 'cancelled' | 'skipped';

let hunkIdCounter = 0;

/**
 * Editor-agnostic, config-driven hunk editor for ONE source. Validates each
 * hunk against the supplied `content` (pure, synchronous — no file system),
 * supports selection-anchored calibration, optional drag-reorder, optional
 * per-hunk selection, and optional LLM auto-fix. The host owns the editor: it
 * pipes selections in via `[selection]` and renders `combinedContent` /
 * `revealLine`. Hunks are a two-way `model` — seed in, edits/auto-fix out.
 */
@Component({
  selector: 'app-hunk-list',
  standalone: true,
  imports: [
    ...CORE_MAT,
    MatCheckboxModule,
    MatProgressSpinnerModule,
    TextFieldModule,
    DragDropModule,
    NgTemplateOutlet,
    TranslatePipe,
  ],
  templateUrl: './hunk-list.component.html',
  styleUrl: './hunk-list.component.scss',
  providers: [HunkAutoFixService],
})
export class HunkListComponent {
  private fileUpdate = inject(FileUpdateService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private i18n = inject(I18nService);
  private autoFix = inject(HunkAutoFixService);

  /** Optional host-supplied calibrate customization (button template + panel labels). */
  calibrateDef = contentChild(HunkCalibrateDirective);

  readonly maxAutoFixAttempts = MAX_AUTO_FIX_ATTEMPTS;

  /** Source text the hunks match against (file content / resolved prompt). */
  content = input<string>('');
  /**
   * Whether the source itself exists. False marks a brand-new source (e.g. a
   * file the auto-update is creating): its hunks render as "new" and never
   * count as unresolved errors. The pure validator always sees content so can't
   * tell — only the host knows.
   */
  sourceExists = input<boolean>(true);
  /** Finished selection from the host editor, fed live for calibration. */
  selection = input<HunkSelection | null>(null);
  config = input<HunkListConfig>({});

  /** Two-way: host seeds the hunks; calibration / edits / auto-fix flow back. */
  hunks = model<FileUpdate[]>([]);
  /** Two-way: the applied result. Host binds it to its editor (may be manually edited). */
  combinedContent = model<string>('');

  /** Ask the host to scroll its editor to a line (1-indexed). */
  revealLine = output<number>();

  /** Internal working items (hunk + transient UI signals). */
  items = signal<HunkItem[]>([]);
  activeId = signal<string | null>(null);
  calibratingId = signal<string | null>(null);

  /** The pure applied result, tracked separately from combinedContent to detect manual edits. */
  private computedContent = signal<string>('');

  /** Reference of the array we last pushed to the model — lets the reseed effect ignore its own echo. */
  private lastEmitted: FileUpdate[] | null = null;

  private t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(`dialog.${key}`, params);
  }

  /** Items with the in-flight calibration selection overlaid (preview + validation use this). */
  private effectiveItems = computed<HunkItem[]>(() => {
    const calId = this.calibratingId();
    const sel = this.selection();
    const its = this.items();
    if (!calId || !sel) return its;
    const context = this.fileUpdate.inferContextFromLine(this.content(), sel.startLineNumber - 1);
    return its.map((it) => (it.id === calId ? { ...it, targetContent: sel.text, context } : it));
  });

  /** Per-hunk validation, recomputed synchronously whenever content or hunks change. */
  validationStatus = computed<Map<string, ValidationResult>>(() => {
    const content = this.content();
    const exists = this.sourceExists();
    const map = new Map<string, ValidationResult>();
    for (const it of this.effectiveItems()) {
      const raw = this.fileUpdate.validateAgainstContent(content, it);
      map.set(it.id, exists ? raw : { ...raw, exists: false });
    }
    return map;
  });

  statusFor(item: HunkItem): ValidationResult | undefined {
    return this.validationStatus().get(item.id);
  }

  private isSelected(item: HunkItem): boolean {
    return this.config().selectable ? item.selected() : true;
  }

  hasMismatch = computed(() =>
    this.items().some((u) => {
      const s = this.validationStatus().get(u.id);
      return s?.exists === true && s.matched === false;
    }),
  );

  /**
   * Any APPLIED (selected) hunk that exists but doesn't match — these would
   * corrupt the result, so the host blocks save while one is present. A
   * never-matched new-source hunk (`!exists`) is not an error.
   */
  hasSelectedUnresolvedError = computed(() =>
    this.items().some((u) => {
      const s = this.validationStatus().get(u.id);
      return this.isSelected(u) && s?.exists === true && s.matched === false;
    }),
  );

  hasFixableErrors = computed(() => this.items().some((u) => this.canAutoFix(u)));

  hasSelectedItems = computed(() => this.items().some((u) => this.isSelected(u)));

  selectedCount = computed(() => this.items().filter((u) => this.isSelected(u)).length);

  constructor() {
    // Reseed internal items when the host pushes a NEW hunk array (ignore the
    // echo of our own model writes via reference identity).
    effect(() => {
      const incoming = this.hunks();
      if (incoming === this.lastEmitted) return;
      untracked(() => this.seed(incoming));
    });

    // Live calibration preview: while a hunk is being calibrated, recompute the
    // combined result on every selection change. Outside calibration a recompute
    // on every keystroke would clobber the host's manual edits.
    effect(() => {
      this.selection();
      if (!this.calibratingId()) return;
      untracked(() => this.recompute());
    });
  }

  private seed(seedHunks: readonly FileUpdate[]): void {
    const items = seedHunks.map<HunkItem>((u) => ({
      ...u,
      id: `hunk_${hunkIdCounter++}`,
      selected: signal(true),
      autoFixAttempts: signal(0),
      autoFixInProgress: signal(false),
    }));
    this.items.set(items);
    this.activeId.set(items[0]?.id ?? null);
    this.calibratingId.set(null);
    this.recompute();
  }

  private toPlain(item: HunkItem): FileUpdate {
    return {
      filePath: item.filePath,
      ...(item.targetContent !== undefined ? { targetContent: item.targetContent } : {}),
      ...(item.replacementContent !== undefined ? { replacementContent: item.replacementContent } : {}),
      ...(item.context !== undefined ? { context: item.context } : {}),
      ...(item.label !== undefined ? { label: item.label } : {}),
    };
  }

  /** Commit a new item list to internal state + the outward model. */
  private commit(items: HunkItem[]): void {
    this.items.set(items);
    const plain = items.map((it) => this.toPlain(it));
    this.lastEmitted = plain;
    this.hunks.set(plain);
    this.recompute();
  }

  /** Recompute the applied result from selected items (+ the calibration overlay). */
  private recompute(): void {
    let result = this.content();
    for (const item of this.effectiveItems()) {
      if (!this.isSelected(item)) continue;
      result = this.fileUpdate.applyUpdateToFile(result, item);
    }
    this.computedContent.set(result);
    this.combinedContent.set(result);
  }

  selectUpdate(item: HunkItem): void {
    this.activeId.set(item.id);
    const line = this.scrollLineFor(item);
    if (line !== null) this.revealLine.emit(line);
  }

  async onCheckboxClick(item: HunkItem, event: Event): Promise<void> {
    event.stopPropagation();
    if (!this.config().selectable) return;
    const target = !item.selected();
    if (await this.confirmDiscardIfDirty(this.t('confirmDiscardSelections'), this.t('discardUpdate'))) {
      item.selected.set(target);
      this.recompute();
    }
  }

  async onDrop(event: CdkDragDrop<HunkItem[]>): Promise<void> {
    if (event.previousIndex === event.currentIndex) return;
    if (await this.confirmDiscardIfDirty(this.t('confirmDiscardReorder'), this.t('discardReorder'))) {
      const items = [...this.items()];
      moveItemInArray(items, event.previousIndex, event.currentIndex);
      this.commit(items);
    }
  }

  // --- Calibration --------------------------------------------------------

  async startCalibration(item: HunkItem): Promise<void> {
    if (!(await this.confirmDiscardIfDirty(this.t('confirmDiscardCalibrate'), this.t('discardCalibrate')))) return;
    this.calibratingId.set(item.id);
    this.activeId.set(item.id);
  }

  cancelCalibration(): void {
    this.calibratingId.set(null);
    this.recompute();
  }

  applyCalibration(item: HunkItem): void {
    const sel = this.selection();
    if (!sel) return;
    const context = this.fileUpdate.inferContextFromLine(this.content(), sel.startLineNumber - 1);
    this.calibratingId.set(null);
    this.commit(this.items().map((it) => (it.id === item.id ? { ...it, targetContent: sel.text, context } : it)));
    this.snackBar.open(this.t('calibrationSuccess'), this.i18n.translate('ui.CLOSE'), { duration: 2000 });
  }

  /** Render context for a host-supplied calibrate-button template. */
  calibrateContext(item: HunkItem): HunkCalibrateContext {
    return {
      $implicit: item,
      active: this.calibratingId() === item.id,
      trigger: (event?: Event) => {
        event?.stopPropagation();
        void this.startCalibration(item);
      },
    };
  }

  /** Seed a brand-new hunk from the current selection (prompt-patch entry flow). */
  createFromSelection(): void {
    const sel = this.selection();
    if (!sel || !this.config().allowCreateFromSelection) return;
    const context = this.fileUpdate.inferContextFromLine(this.content(), sel.startLineNumber - 1);
    const item: HunkItem = {
      filePath: this.items()[0]?.filePath ?? '',
      targetContent: sel.text,
      replacementContent: '',
      context,
      id: `hunk_${hunkIdCounter++}`,
      selected: signal(true),
      autoFixAttempts: signal(0),
      autoFixInProgress: signal(false),
    };
    this.commit([...this.items(), item]);
    this.activeId.set(item.id);
    this.calibratingId.set(item.id);
  }

  async removeHunk(item: HunkItem): Promise<void> {
    const ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        message: this.t('deleteHunkConfirm'),
        okText: this.i18n.translate('ui.HUNK_DELETE'),
      } as ConfirmDialogData,
    });
    if (!(await firstValueFrom(ref.afterClosed()))) return;
    this.calibratingId.update((id) => (id === item.id ? null : id));
    const remaining = this.items().filter((it) => it.id !== item.id);
    this.commit(remaining);
    this.activeId.update((id) => (id === item.id ? remaining[0]?.id ?? null : id));
  }

  onHunkContentChange(item: HunkItem, type: 'target' | 'replacement', event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.commit(
      this.items().map((it) =>
        it.id === item.id
          ? { ...it, ...(type === 'target' ? { targetContent: value } : { replacementContent: value }) }
          : it,
      ),
    );
  }

  // --- Auto-fix (gated by config.autofixEnable) ---------------------------

  canAutoFix(item: HunkItem): boolean {
    if (!this.config().autofixEnable) return false;
    const s = this.validationStatus().get(item.id);
    const reason = s?.failReason;
    return (
      s?.exists === true &&
      s.matched === false &&
      (reason === 'target_not_found' || reason === 'context_mismatch') &&
      item.autoFixAttempts() < MAX_AUTO_FIX_ATTEMPTS
    );
  }

  async requestAutoFix(item: HunkItem, opts?: { autoApply?: boolean }): Promise<AutoFixOutcome> {
    if (!this.canAutoFix(item)) return 'skipped';
    if (item.autoFixInProgress()) return 'skipped';
    const autoApply = opts?.autoApply === true;
    const status = this.validationStatus().get(item.id);
    const notify = (key: string, params?: Record<string, string | number>, duration = 3000): void => {
      if (!autoApply) this.snackBar.open(this.t(key, params), this.i18n.translate('ui.CLOSE'), { duration });
    };
    const reportUnmatched = (): AutoFixOutcome => {
      const next = item.autoFixAttempts() + 1;
      item.autoFixAttempts.set(next);
      notify(next >= MAX_AUTO_FIX_ATTEMPTS ? 'autoFixLimitReached' : 'autoFixStillFailed', {
        attempts: next,
        max: MAX_AUTO_FIX_ATTEMPTS,
      }, 4000);
      return 'unmatched';
    };

    item.autoFixInProgress.set(true);
    const abortController = new AbortController();
    const progressRef = this.dialog.open(HunkAutoFixProgressDialogComponent, {
      data: { fileName: item.filePath, abortController } satisfies HunkAutoFixProgressData,
      disableClose: true,
      width: '640px',
      maxWidth: '95vw',
    });
    const progress = progressRef.componentInstance;
    try {
      const result = await this.autoFix.fix({
        fileName: item.filePath,
        sourceContent: this.content(),
        intendedTarget: item.targetContent ?? '',
        intendedReplacement: item.replacementContent ?? '',
        context: item.context,
        failReason: status!.failReason!,
        signal: abortController.signal,
        onThoughtChunk: (text) => progress.appendThought(text),
        onOutputChunk: (text) => progress.appendOutput(text),
        onUsage: (usage) => progress.setUsage(usage),
        onRoundStart: (round, max) => progress.startRound(round, max),
      });
      progressRef.close();

      if (abortController.signal.aborted) return 'aborted';
      if (!result) {
        item.autoFixAttempts.update((n) => n + 1);
        notify('autoFixFailed');
        return 'failed';
      }
      if (!result.target && !result.replacement) {
        item.autoFixAttempts.set(MAX_AUTO_FIX_ATTEMPTS);
        notify('autoFixIdempotent');
        return 'idempotent';
      }
      if (!result.matched) return reportUnmatched();

      if (!autoApply) {
        const previewData: HunkFixPreviewData = {
          oldTarget: item.targetContent ?? '',
          newTarget: result.target,
          oldReplacement: item.replacementContent ?? '',
          newReplacement: result.replacement,
          oldContext: item.context ?? [],
          newContext: result.context,
        };
        const confirmed = await firstValueFrom(
          this.dialog.open(HunkFixPreviewDialogComponent, { data: previewData }).afterClosed(),
        );
        if (!confirmed) return 'cancelled';
      }

      this.commit(
        this.items().map((it) =>
          it.id === item.id
            ? { ...it, targetContent: result.target, replacementContent: result.replacement, context: result.context }
            : it,
        ),
      );

      if (this.validationStatus().get(item.id)?.matched) {
        item.autoFixAttempts.set(0);
        notify('autoFixSuccess', undefined, 2000);
        return 'applied';
      }
      return reportUnmatched();
    } finally {
      item.autoFixInProgress.set(false);
      progressRef.close();
    }
  }

  async requestAutoFixAll(): Promise<void> {
    const targets = this.items().filter((u) => this.canAutoFix(u));
    if (targets.length === 0) return;

    let applied = 0;
    let failed = 0;
    for (const target of targets) {
      const current = this.items().find((u) => u.id === target.id);
      if (!current || !this.canAutoFix(current)) continue;
      const outcome = await this.requestAutoFix(current, { autoApply: true });
      if (outcome === 'applied') applied++;
      else if (outcome === 'aborted') break;
      else failed++;
    }
    this.snackBar.open(this.t('autoFixAllSummary', { applied, failed }), this.i18n.translate('ui.CLOSE'), {
      duration: 4000,
    });
  }

  // --- Helpers ------------------------------------------------------------

  private async confirmDiscardIfDirty(message: string, okText: string): Promise<boolean> {
    if (this.combinedContent() === this.computedContent()) return true;
    const ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.t('discardEditsTitle'),
        message,
        okText,
        cancelText: this.t('cancel'),
      } as ConfirmDialogData,
    });
    return !!(await firstValueFrom(ref.afterClosed()));
  }

  private scrollLineFor(item: HunkItem): number | null {
    const search = item.replacementContent || item.targetContent;
    if (!search) return null;
    const content = this.combinedContent();
    const range = this.fileUpdate.findMatchRange(content, search, item.context);
    if (range) return content.substring(0, range.start).split(/\r?\n/).length;
    if (item.context && item.context.length > 0) {
      const line = this.fileUpdate.findContextLine(content, item.context);
      if (line !== null) return line + 1;
    }
    return null;
  }
}
