import { Component, inject, signal, effect, untracked, WritableSignal, viewChild } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef, MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTabsModule } from '@angular/material/tabs';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TextFieldModule } from '@angular/cdk/text-field';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MonacoEditorComponent } from '../monaco-editor/monaco-editor.component';
import { FileUpdate, FileUpdateService } from '../../../core/services/file-update.service';
import { FileSystemService } from '../../../core/services/file-system.service';
import { GameEngineService } from '../../../core/services/game-engine.service';
import { CommonModule } from '@angular/common';
import { ConfirmDialogComponent, ConfirmDialogData } from '../confirm-dialog/confirm-dialog.component';
import { GAME_INTENTS } from '../../../core/constants/game-intents';
import { getCoreFilenames } from '../../../core/constants/engine-protocol';

interface ValidationStatus {
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
  selected: import('@angular/core').WritableSignal<boolean>;
  status?: ValidationStatus;
};

interface GroupedUpdate {
  fileName: string;
  updates: MonacoUpdateItem[];
  originalContent: WritableSignal<string>;
  combinedContent: WritableSignal<string>;
  computedContent: WritableSignal<string>;
}

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
    MonacoEditorComponent
  ],
  templateUrl: './auto-update-dialog.component.html',
  styleUrl: './auto-update-dialog.component.scss'
})
export class AutoUpdateDialogComponent {
  public dialogRef = inject<MatDialogRef<AutoUpdateDialogComponent>>(MatDialogRef);
  public data = inject<{ updates: FileUpdate[] }>(MAT_DIALOG_DATA);
  private updateService = inject(FileUpdateService);
  private fileSystem = inject(FileSystemService);
  private engine = inject(GameEngineService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  updates = signal<FileUpdate[]>([]);
  groupedUpdates = signal<GroupedUpdate[]>([]);
  activeGroupIndex = signal(0);
  activeUpdate = signal<MonacoUpdateItem | null>(null);
  isInitializing = signal(true);
  filesLoaded = signal(false);
  isSidebarOpen = signal(true); // Controls left panel visibility on mobile

  // Reference to the Monaco editor component
  private monacoEditor = viewChild(MonacoEditorComponent);

  activeGroup = () => this.groupedUpdates()[this.activeGroupIndex()] || null;

  toggleSidebar() {
    this.isSidebarOpen.update(v => !v);
  }

  selectGroup(index: number) {
    this.activeGroupIndex.set(index);
    const group = this.groupedUpdates()[index];
    if (group && group.updates.length > 0) {
      this.activeUpdate.set(group.updates[0]);
    }
  }



  constructor() {
    // 1. Initialize updates signal from static data, augmenting with auto-generated last_scene hunk
    const baseUpdates = [...this.data.updates];
    const lastSceneHunk = this.generateAutoLastSceneHunk();
    if (lastSceneHunk) {
      baseUpdates.push(lastSceneHunk);
    }
    this.updates.set(baseUpdates);

    // 2. React to updates change -> Group them
    effect(() => {
      const currentUpdates = this.updates();
      if (currentUpdates.length > 0) {
        untracked(() => {
          this.groupUpdates(currentUpdates);
        });
      }
    });

    // 3. Trigger validation when files are fully loaded
    effect(() => {
      if (this.filesLoaded()) {
        untracked(() => {
          this.validateAll();
        });
      }
    });
  }

  /**
   * Generates a last_scene hunk from the last story-type model response.
   * Story intents are: <行動意圖>, <繼續>, <快轉>
   */
  private generateAutoLastSceneHunk(): FileUpdate | null {
    // 1. Check if there are any manual updates for the plot outline from the model
    const lang = this.engine.config()?.outputLanguage || 'default';
    const names = getCoreFilenames(lang);
    const hasPlotOutlineUpdate = this.data.updates.some(u => u.filePath.includes(names.STORY_OUTLINE));
    if (!hasPlotOutlineUpdate) {
      return null;
    }

    const storyIntents = [GAME_INTENTS.ACTION, GAME_INTENTS.CONTINUE, GAME_INTENTS.FAST_FORWARD];
    const messages = this.engine.messages();

    // Find the last model message with story-type intent (not ref-only)
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

  // No ngOnInit needed

  async groupUpdates(fileUpdates: FileUpdate[]) {
    // Reset state
    this.filesLoaded.set(false);
    this.isInitializing.set(true);

    let counter = 0;
    const map = new Map<string, MonacoUpdateItem[]>();

    for (const update of fileUpdates) {
      if (!map.has(update.filePath)) {
        map.set(update.filePath, []);
      }
      map.get(update.filePath)!.push({
        ...update,
        id: `upd_${counter++}`,
        selected: signal(true),
        status: { exists: false, matched: false, validating: true }
      });
    }

    console.log('[AutoUpdateDialog] Grouping updates...', fileUpdates.length);
    try {
      const groups: GroupedUpdate[] = [];
      for (const [fileName, updates] of map.entries()) {
        console.log('[AutoUpdateDialog] Processing file', fileName);
        let originalContent = '';
        try {
          originalContent = await this.fileSystem.readTextFile(fileName);
          console.log('[AutoUpdateDialog] Loaded original content', fileName, originalContent.length);
        } catch (e: unknown) {
          console.warn(`File ${fileName} not found for combined view:`, e);
        }

        // Preprocess updates (handles special cases like 劇情綱要.md last_scene)
        // processedUpdates might contain new synthetic objects (missing ID/Signal) or existing ones (with Signal)
        const rawProcessedUpdates = this.updateService.preprocessUpdates(updates, fileName, originalContent);

        const processedUpdates: MonacoUpdateItem[] = rawProcessedUpdates.map((u) => {
          // Check if it already has a signal selected property (existing items)
          const updateItem = u as Partial<MonacoUpdateItem>;
          const isSignal = updateItem.selected && typeof updateItem.selected === 'function' && 'set' in updateItem.selected;

          return {
            ...u,
            id: updateItem.id || `upd_${counter++}`,
            selected: isSignal ? (updateItem.selected as WritableSignal<boolean>) : signal(true),
            status: updateItem.status || { exists: false, matched: false, validating: true }
          };
        });

        const group: GroupedUpdate = {
          fileName,
          updates: processedUpdates,
          originalContent: signal(originalContent),
          combinedContent: signal(''),
          computedContent: signal('')
        };
        this.recomputeCombinedContent(group);
        groups.push(group);
      }

      this.groupedUpdates.set(groups);
      console.log('[AutoUpdateDialog] Processed groups:', groups.length);

      // Select first update by default
      if (groups.length > 0 && groups[0].updates.length > 0) {
        this.selectUpdate(groups[0].updates[0]);
      }

      // Mark files as loaded to trigger validation effect
      this.filesLoaded.set(true);
    } catch (err) {
      console.error('[AutoUpdateDialog] Error grouping updates:', err);
      this.snackBar.open('Error processing updates', 'Close');
    } finally {
      this.isInitializing.set(false);
    }
  }

  recomputeCombinedContent(group: GroupedUpdate) {
    let result = group.originalContent();
    // Apply all selected updates to the original content
    for (const update of group.updates) {
      if (update.selected()) {
        result = this.localApplyUpdate(result, update);
      }
    }
    group.computedContent.set(result);
    group.combinedContent.set(result);
  }

  private localApplyUpdate(content: string, update: FileUpdate): string {
    return this.updateService.applyUpdateToFile(content, update);
  }


  async onCheckboxClick(group: GroupedUpdate, update: MonacoUpdateItem, event: Event) {
    // Stop propagation to prevent selecting the parent row when clicking the checkbox
    event.stopPropagation();

    // We don't need preventDefault() anymore because the checkbox itself ignores clicks (pointer-events: none)
    // The click is handled by the wrapper div.

    const currentChecked = update.selected();
    const targetChecked = !currentChecked;

    if (group.combinedContent() !== group.computedContent()) {
      // Content is dirty (manually edited)
      const dialogRef = this.dialog.open(ConfirmDialogComponent, {
        data: {
          title: 'Discard Manual Edits?',
          message: 'You have manually edited the file. Changing selections will discard your edits. Continue?',
          okText: 'Discard & Update',
          cancelText: 'Cancel'
        } as ConfirmDialogData
      });

      const result = await firstValueFrom(dialogRef.afterClosed());
      if (result) {
        update.selected.set(targetChecked);
        this.recomputeCombinedContent(group);
      }
      // If cancelled, do nothing. Since we prevented default, the UI is still in the original state.
    } else {
      update.selected.set(targetChecked);
      this.recomputeCombinedContent(group);
    }
  }

  selectUpdate(update: MonacoUpdateItem) {
    this.activeUpdate.set(update);
    this.scrollToHunk(update);
  }

  /**
   * Scroll the Monaco editor to show the hunk location.
   * Finds the position of the replacement content in the combined content.
   */
  private scrollToHunk(update: MonacoUpdateItem): void {
    const editor = this.monacoEditor();
    const group = this.activeGroup();
    if (!editor || !group) return;

    // Find the content to search for in the combined result
    const searchContent = update.replacementContent || update.targetContent;
    if (!searchContent) return;

    // Find position in combined content
    const combinedContentStr = group.combinedContent();
    const range = this.updateService.findMatchRange(combinedContentStr, searchContent, update.context);

    if (range) {
      // Convert char index to line number (1-indexed)
      const lineNumber = combinedContentStr.substring(0, range.start).split(/\r?\n/).length;
      // Small delay to ensure editor is ready after tab switch
      setTimeout(() => editor.revealLine(lineNumber), 50);
    }
  }

  async onDrop(group: GroupedUpdate, event: CdkDragDrop<MonacoUpdateItem[]>) {
    if (event.previousIndex === event.currentIndex) {
      return; // No change
    }

    if (group.combinedContent() !== group.computedContent()) {
      // Content is dirty (manually edited)
      const dialogRef = this.dialog.open(ConfirmDialogComponent, {
        data: {
          title: 'Discard Manual Edits?',
          message: 'You have manually edited the file. Reordering will discard your edits. Continue?',
          okText: 'Discard & Reorder',
          cancelText: 'Cancel'
        } as ConfirmDialogData
      });

      const result = await firstValueFrom(dialogRef.afterClosed());
      if (result) {
        moveItemInArray(group.updates, event.previousIndex, event.currentIndex);
        this.recomputeCombinedContent(group);
        this.groupedUpdates.update(groups => [...groups]);
      }
    } else {
      moveItemInArray(group.updates, event.previousIndex, event.currentIndex);
      this.recomputeCombinedContent(group);
      this.groupedUpdates.update(groups => [...groups]);
    }
  }

  async validateAll() {
    console.log('[AutoUpdateDialog] Starting validation...');
    const currentGroups = this.groupedUpdates(); // Get current value

    // We need to mutate a copy to avoid signal issues, or update in place carefully.
    // Since we want granular updates, we'll iterate and update the signal container.

    for (const group of currentGroups) {
      for (let i = 0; i < group.updates.length; i++) {
        const update = group.updates[i];
        console.log(`[AutoUpdateDialog] Validating ${update.id}...`);

        try {
          // 1. Run validation
          const result = await this.updateService.validateUpdate(update);

          // 2. Create NEW object to ensure change detection picks it up
          const newUpdate = {
            ...update,
            status: {
              exists: result.exists,
              matched: result.matched,
              alreadyExists: result.alreadyExists,
              beforeLines: result.beforeLines,
              afterLines: result.afterLines,
              matchIndex: result.matchIndex,
              failReason: result.failReason,
              validating: false
            }
          };

          // 3. Update the array in place (reference in group)
          group.updates[i] = newUpdate;

          // 4. If this was active, update active signal too
          if (this.activeUpdate()?.id === update.id) {
            this.activeUpdate.set(newUpdate);
          }

          console.log(`[AutoUpdateDialog] Validated ${update.id}:`, newUpdate.status);

        } catch (err) {
          console.error(`[AutoUpdateDialog] Validation failed for ${update.id}`, err);
          // Mark as not validating so spinner stops even on error
          const errorUpdate = {
            ...update,
            status: { ...update.status!, validating: false }
          };
          group.updates[i] = errorUpdate;
        }

        // 5. Trigger Signal Update
        this.groupedUpdates.update(groups => [...groups]);
      }
    }
    console.log('[AutoUpdateDialog] All validations complete.');
  }



  hasMismatch(group: GroupedUpdate): boolean {
    return group.updates.some(u => u.status && u.status.exists && !u.status.matched);
  }

  hasSelectedUpdates(): boolean {
    const groups = this.groupedUpdates();
    return groups && groups.some(group => group.updates && group.updates.some(u => u.selected()));
  }

  hasSelectedInGroup(group: GroupedUpdate): boolean {
    return group.updates && group.updates.some(u => u.selected());
  }

  onCancel() {
    this.dialogRef.close();
  }

  async onApply() {
    this.isInitializing.set(true);
    try {
      const allSelected = this.groupedUpdates().flatMap(g => g.updates.filter(u => u.selected()));
      if (allSelected.length === 0) {
        this.snackBar.open('No files to apply', 'Close', { duration: 2000 });
        return;
      }

      // Show confirmation dialog
      const dialogRef = this.dialog.open(ConfirmDialogComponent, {
        data: {
          title: 'Apply All Changes',
          message: `Apply changes to ${allSelected.length} hunk(s) across ${this.groupedUpdates().filter(g => g.updates.some(u => u.selected())).length} file(s)?`,
          okText: 'Apply All',
          cancelText: 'Cancel'
        } as ConfirmDialogData
      });

      const confirmed = await dialogRef.afterClosed().toPromise();
      if (!confirmed) return;

      for (const group of this.groupedUpdates()) {
        const hasSelected = group.updates.some(u => u.selected());
        if (hasSelected) {
          // Use the user-edited content from combinedContent signal
          await this.engine.updateSingleFile(group.fileName, group.combinedContent());
        }
      }
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
  async onApplyFile(group: GroupedUpdate) {
    const hasSelected = group.updates.some(u => u.selected());
    if (!hasSelected) {
      this.snackBar.open('No hunks selected for this file', 'Close', { duration: 2000 });
      return;
    }

    // Show confirmation dialog
    const dialogRef = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: 'Apply Changes to Current File',
        message: `Apply ${group.updates.filter(u => u.selected()).length} selected hunk(s) to "${group.fileName}"?`,
        okText: 'Apply',
        cancelText: 'Cancel'
      } as ConfirmDialogData
    });

    const confirmed = await dialogRef.afterClosed().toPromise();
    if (!confirmed) return;

    this.isInitializing.set(true);
    try {
      // Apply the combined content for this specific file
      await this.engine.updateSingleFile(group.fileName, group.combinedContent());

      // Refresh: update originalContent to match what was just written
      group.originalContent.set(group.combinedContent());
      group.computedContent.set(group.combinedContent());

      // Re-validate the hunks (most should now show "already exists" or need re-matching)
      for (const update of group.updates) {
        update.status = { exists: false, matched: false, validating: true };
      }
      this.groupedUpdates.update(groups => [...groups]);

      // Re-run validation for this group
      await this.validateAll();

      this.snackBar.open(`Applied changes to ${group.fileName}`, 'OK', { duration: 2000 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.snackBar.open('Failed to apply: ' + message, 'Close', { duration: 3000 });
    } finally {
      this.isInitializing.set(false);
    }
  }
}
