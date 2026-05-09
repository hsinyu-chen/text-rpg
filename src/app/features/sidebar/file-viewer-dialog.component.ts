import { Component, inject, signal, computed, viewChild, effect, OnDestroy } from '@angular/core';
import { WINDOW } from '@app/core/tokens/window.token';
import { CommonModule } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { FormsModule } from '@angular/forms';
import { MonacoEditorComponent } from '@app/shared/components/monaco-editor/monaco-editor.component';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ConfirmDialogComponent } from '@app/shared/components/confirm-dialog/confirm-dialog.component';
import { MatDialog } from '@angular/material/dialog';
import { GameStateService } from '@app/core/services/game-state.service';
import { CacheManagerService } from '@app/core/services/cache-manager.service';
import { FileAgentService } from '@app/core/services/file-agent/file-agent.service';
import { WorldCompletionValidator } from '@app/core/services/file-agent/world-completion-validator';
import { AgentConsoleComponent } from '@app/shared/components/agent-console/agent-console.component';
import { SessionService } from '@app/core/services/session.service';
import { findAtxHeadings } from '@app/core/utils/markdown.util';
import { FileSearchEngine, type SearchResult } from './file-search/file-search-engine';
import { I18nService, TranslatePipe } from '@app/core/i18n';

/** Dialog data interface for multi-file viewer */
export interface FileViewerDialogData {
  /** All files to load: filename -> content */
  files: Map<string, string>;
  /** Initially selected file name */
  initialFile: string;
  /** Whether to start in edit mode */
  editMode?: boolean;
  /** Create World mode: hides Save, shows Start Game, auto-runs agent */
  createWorldMode?: boolean;
  /** Prompt auto-sent to the agent on open (used with createWorldMode) */
  initialAgentPrompt?: string;
  /** Book name used when starting the game in createWorldMode */
  worldName?: string;
  /** Completion validator injected by the caller (createWorldMode only). */
  completionValidator?: WorldCompletionValidator;
  /** LLM profile ID to pre-select when the agent panel opens (createWorldMode only). */
  initialProfileId?: string;
}

/** Markdown header interface */
export interface MarkdownHeader {
  level: number;
  text: string;
  lineNumber: number;
}

@Component({
  selector: 'app-file-viewer-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatTooltipModule,
    MatInputModule,
    MatFormFieldModule,
    FormsModule,
    MonacoEditorComponent,
    AgentConsoleComponent,
    TranslatePipe
  ],
  templateUrl: './file-viewer-dialog.component.html',
  styleUrl: './file-viewer-dialog.component.scss',
  providers: [FileAgentService, FileSearchEngine]
})
export class FileViewerDialogComponent implements OnDestroy {
  data = inject(MAT_DIALOG_DATA) as FileViewerDialogData;
  private dialogRef = inject(MatDialogRef<FileViewerDialogComponent>);
  private engine = inject(GameEngineService);
  private state = inject(GameStateService);
  private session = inject(SessionService);
  private snackBar = inject(MatSnackBar);
  private matDialog = inject(MatDialog);
  private cacheManager = inject(CacheManagerService);
  private fileAgentService = inject(FileAgentService);
  searchEngine = inject(FileSearchEngine);
  private readonly win = inject(WINDOW);
  private i18n = inject(I18nService);

  private t(key: string, params?: Record<string, string | number>): string {
    return this.i18n.translate(`sidebar.fileViewer.${key}`, params);
  }

  isStartingGame = signal(false);

  // Editor reference
  editorRef = viewChild<MonacoEditorComponent>('editorRef');

  // Active file selection
  activeFile = signal('');

  // Saving state
  isSaving = signal(false);

  // Set of filenames with unsaved changes - now tracked in GameStateService
  unsavedFiles = this.state.unsavedFiles;

  // File list sidebar collapsed state (for mobile)
  isSidebarCollapsed = signal(false);

  // Active file content (updated by Monaco to keep outline reactive)
  activeFileContent = signal('');

  // Sidebar view mode: 'files' or 'search' or 'agent'
  sidebarView = signal<'files' | 'search' | 'agent'>('files');
  
  // Manual toggle for diff view (independent of sidebar mode)
  isDiffView = signal(false);

  /**
   * Snapshot of the files as they exist in the database (last saved state).
   * Used as the "original" side of the multi-file diff editor in the agent tab.
   * Updated only when a file is successfully saved.
   */
  dbBaselineSnapshot = signal<Map<string, string>>(new Map(this.data.files));

  // Derived file list for sidebar display
  fileList = computed(() => {
    const list: string[] = [];
    this.data.files.forEach((_, name) => list.push(name));
    return list.sort();
  });

  // Check if current file can be edited
  canEdit = computed(() => {
    const active = this.activeFile();
    // Only allow editing files that aren't in system_files directory
    return active && !active.startsWith('system_files/');
  });

  // Extract outline from markdown content
  outline = computed(() => {
    const content = this.activeFileContent();
    const active = this.activeFile();
    if (!active.endsWith('.md')) return [];

    return findAtxHeadings(content.split('\n')).map(h => ({
      level: h.level,
      text: h.text,
      lineNumber: h.index + 1,
    } as MarkdownHeader));
  });

  // Monaco editor options - always allowing editing now
  editorOptions = computed(() => ({
    readOnly: false,
    minimap: { enabled: false }
  }));

  // Diff-mode options used while the agent tab is open. Inline diff
  // (renderSideBySide:false) keeps the visual the same column-width as
  // the normal editor; modified side stays editable so the user can
  // tweak the agent's output before saving.
  agentDiffEditorOptions = computed(() => ({
    readOnly: false,
    originalEditable: false,
    renderSideBySide: false,
    minimap: { enabled: false }
  }));

  // Store decoration collection for cleanup
  private decorationsCollection: import('monaco-editor').editor.IEditorDecorationsCollection | null = null;
  private highlightTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Defensive copy: sidebar passes state.loadedFiles() by reference, so
    // every keystroke would otherwise mutate the caller's Map and persist
    // unsaved edits across cancel + reopen.
    this.data.files = new Map(this.data.files);

    this.searchEngine.bind(this.data.files, (fileName, content) => {
      this.editorRef()?.updateFileContent(fileName, content);
      // Replace All can mutate non-active files which never reach Monaco's
      // valueChange path — sync unsaved state explicitly so the close-confirm
      // dialog still fires.
      const savedContent = this.dbBaselineSnapshot().get(fileName) ?? '';
      this.unsavedFiles.update((set) => {
        const next = new Set(set);
        if (content !== savedContent) next.add(fileName);
        else next.delete(fileName);
        return next;
      });
    });

    // Initialize active file
    if (this.data.initialFile) {
      this.activeFile.set(this.data.initialFile);
    } else if (this.data.files.size > 0) {
      // Default to first file
      const firstFile = this.data.files.keys().next().value;
      if (firstFile) {
        this.activeFile.set(firstFile);
      }
    }

    // Auto-open agent panel when an initial prompt is supplied (Create World mode)
    if (this.data.createWorldMode && this.data.initialAgentPrompt) {
      this.sidebarView.set('agent');
    }

    if (this.data.completionValidator) {
      this.fileAgentService.setCompletionValidator(this.data.completionValidator);
    }

    if (this.data.initialProfileId) {
      this.fileAgentService.selectProfile(this.data.initialProfileId);
    }

    // React to agent file replacements via service signal.
    // editorRef() is read BEFORE the early return so it is always tracked as
    // a dependency — required by Angular's dynamic dependency tracking.
    effect(() => {
      const editor = this.editorRef();
      const replacements = this.fileAgentService.lastFilesReplaced();
      if (!replacements.length) return;
      for (const replaced of replacements) {
        if (editor) editor.updateFileContent(replaced.filename, replaced.content);
        this.unsavedFiles.update(s => new Set(s).add(replaced.filename));
      }
    });

    // Effect to sync content when active file changes
    effect(() => {
      const fileName = this.activeFile();
      const initialContent = this.data.files.get(fileName) || '';
      this.activeFileContent.set(initialContent);
    });

    // Effect to highlight matches when search results or active file changes
    effect(() => {
      const results: SearchResult[] = this.searchEngine.searchResource.value() ?? [];
      const activeFileName = this.activeFile();
      void this.editorRef();

      if (this.highlightTimeoutId !== null) clearTimeout(this.highlightTimeoutId);
      this.highlightTimeoutId = setTimeout(() => {
        this.highlightTimeoutId = null;
        this.highlightMatches(results, activeFileName);
      }, 150);
    });

  }

  /** Apply highlight decorations to the current file's matches */
  private highlightMatches(results: SearchResult[], activeFileName: string): void {
    const editorComponent = this.editorRef();
    if (!editorComponent) return;

    const editor = editorComponent.getEditor();
    if (!editor || !('createDecorationsCollection' in editor)) return;

    const codeEditor = editor as import('monaco-editor').editor.IStandaloneCodeEditor;

    // Clear existing decorations
    if (this.decorationsCollection) {
      this.decorationsCollection.clear();
    }

    // Get matches for current file only
    const currentFileMatches = results.filter(r => r.fileName === activeFileName);

    // Build decorations
    const decorations: import('monaco-editor').editor.IModelDeltaDecoration[] = currentFileMatches.map(match => ({
      range: {
        startLineNumber: match.lineNumber,
        startColumn: match.matchIndex + 1,
        endLineNumber: match.lineNumber,
        endColumn: match.matchIndex + 1 + (match.matchLength)
      },
      options: {
        className: 'search-match-highlight',
        overviewRuler: {
          color: '#ffd33d',
          position: 4 // Right
        }
      }
    }));

    // Create new decorations collection
    this.decorationsCollection = codeEditor.createDecorationsCollection(decorations);
  }

  /** Toggle global diff view mode */
  toggleDiffView(): void {
    this.isDiffView.update(v => !v);
  }

  /** Replace All — engine does the work; show snackbar on completion. */
  async runReplaceAllMatches(): Promise<void> {
    const { replaced, files } = await this.searchEngine.replaceAllMatches();
    if (replaced > 0) {
      this.snackBar.open(this.t('replaceSuccess', { replaced, files }), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
    }
  }

  /** Navigate to a search result */
  goToResult(result: SearchResult): void {
    // Switch to the file
    this.activeFile.set(result.fileName);

    // After a short delay to allow model switch, scroll to line and position cursor at match
    setTimeout(() => {
      const editorComponent = this.editorRef();
      if (editorComponent) {
        // Use revealLine with column for precise cursor positioning (matchIndex is 0-based, column is 1-based)
        editorComponent.revealLine(result.lineNumber, result.matchIndex + 1);
      }
    }, 100);
  }

  /** Navigate to a markdown header */
  goToHeader(header: MarkdownHeader): void {
    const editorComponent = this.editorRef();
    if (editorComponent) {
      editorComponent.revealLine(header.lineNumber, 1);
    }
  }

  /** Select a file from the sidebar */
  selectFile(fileName: string): void {
    if (this.activeFile() === fileName) return;

    // Get current content from editor for the file we are leaving
    const editor = this.editorRef();
    if (editor) {
      const currentContent = editor.getFileContent(this.activeFile());
      if (currentContent !== undefined) {
        this.activeFileContent.set(currentContent);
      }
    }

    this.activeFile.set(fileName);

    const newInitialContent = this.data.files.get(fileName) || '';
    if (editor) {
      const existingModelContent = editor.getFileContent(fileName);
      if (existingModelContent !== undefined) {
        this.activeFileContent.set(existingModelContent);
      } else {
        this.activeFileContent.set(newInitialContent);
      }
    }

    // Collapse sidebar on mobile after selection
    if (this.win.innerWidth < 768) {
      this.isSidebarCollapsed.set(true);
    }
  }

  /** Handle value changes from Monaco */
  onValueChange(newValue: string): void {
    this.activeFileContent.set(newValue);
    const fileName = this.activeFile();

    // Keep data.files in sync with live edits so the editor can be recreated
    // (e.g. on diff toggle) without losing in-progress changes.
    this.data.files.set(fileName, newValue);

    // Compare against dbBaselineSnapshot (last-saved state) — not data.files —
    // so that updating data.files above does not clear the unsaved indicator.
    const savedContent = this.dbBaselineSnapshot().get(fileName) ?? '';
    this.unsavedFiles.update((set: Set<string>) => {
      const next = new Set(set);
      if (newValue !== savedContent) {
        next.add(fileName);
      } else {
        next.delete(fileName);
      }
      return next;
    });
  }

  /** Toggle sidebar visibility */
  toggleSidebar(): void {
    this.isSidebarCollapsed.update(v => !v);
  }

  /** Save current file */
  async save(): Promise<void> {
    const fileName = this.activeFile();
    if (!fileName) return;

    const editor = this.editorRef();
    if (!editor) return;

    this.isSaving.set(true);
    try {
      // Get content from Monaco model
      const content = editor.getFileContent(fileName);
      if (content === undefined) {
        throw new Error('Unable to get file content');
      }

      // Use engine.updateSingleFile — this writes to file_store, updates state.loadedFiles,
      // refreshes token counts, and invalidates the KB cache hash.
      await this.engine.updateSingleFile(fileName, content);

      // Server-side orphan-cache cleanup is cost-only — correctness is already
      // handled by updateSingleFile (nulls kbCacheName, refreshes kbCacheHash;
      // checkCacheAndRefresh rebuilds on the next chat turn). Skip it while the
      // file agent is running: on llama.cpp's single-slot model, deleteAllCaches
      // POSTs /slots/0?action=erase and aborts the in-flight inference (also
      // raises a loading mask that won't lift until the agent unblocks).
      if (!this.fileAgentService.isAgentRunning()) {
        await this.cacheManager.clearAllServerCaches();
      }

      // Persist the in-memory session state into the current Book entity.
      // Without this, loadBook() on next reload would wipe the change from file_store.
      await this.engine.saveCurrentSessionToBook();

      this.snackBar.open(this.t('saveSuccess'), this.i18n.translate('ui.CLOSE'), { duration: 3000 });
      // Update the local data map
      this.data.files.set(fileName, content);
      
      // Update the baseline snapshot for the saved file so the diff resets
      this.dbBaselineSnapshot.update(map => {
        const next = new Map(map);
        next.set(fileName, content);
        return next;
      });

      // Reset the original model in Monaco so the diff shows no changes after saving.
      // dbBaselineSnapshot signal alone does not update the live originalModelMap.
      editor.updateOriginalFileContent(fileName, content);

      // Remove from unsaved files
      this.unsavedFiles.update((set: Set<string>) => {
        const next = new Set(set);
        next.delete(fileName);
        return next;
      });
    } catch (err) {
      console.error('Save failed:', err);
      this.snackBar.open(this.t('saveFailed'), this.i18n.translate('ui.CLOSE'), { duration: 5000 });
    } finally {
      this.isSaving.set(false);
    }
  }

  /** Start the game from Create World mode: persist files as a new Book and close */
  async startGame(): Promise<void> {
    const worldName = this.data.worldName || 'New World';
    this.isStartingGame.set(true);
    try {
      await this.session.createSceneBook(worldName, this.data.files);
      await this.engine.startSession();
      this.unsavedFiles.set(new Set());
      this.dialogRef.close(true);
    } catch (err) {
      console.error('Start game failed:', err);
      this.snackBar.open(this.t('startGameFailed'), this.i18n.translate('ui.CLOSE'), { duration: 5000 });
    } finally {
      this.isStartingGame.set(false);
    }
  }

  /** Close the dialog */
  async close(): Promise<void> {
    // In Create World mode the files are in-memory only — no save confirmation needed
    if (!this.data.createWorldMode && this.unsavedFiles().size > 0) {
      const ref = this.matDialog.open(ConfirmDialogComponent, {
        data: {
          title: this.t('unsavedTitle'),
          message: this.t('unsavedMessage', { count: this.unsavedFiles().size }),
          okText: this.t('leaveBtn'),
          cancelText: this.t('stayBtn')
        }
      });

      const confirmed = await firstValueFrom(ref.afterClosed());
      if (!confirmed) return;
    }
    // Clear unsaved files set when closing
    this.unsavedFiles.set(new Set());
    this.dialogRef.close();
  }

  ngOnDestroy(): void {
    // Also clear here just in case it was closed via backdrop or escape key
    this.unsavedFiles.set(new Set());
    if (this.highlightTimeoutId !== null) clearTimeout(this.highlightTimeoutId);
  }

}
