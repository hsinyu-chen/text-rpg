import { Component, inject, signal, computed, viewChild, effect, resource, OnDestroy } from '@angular/core';
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
import { MonacoEditorComponent } from '../../shared/components/monaco-editor/monaco-editor.component';
import { FileSystemService } from '../../core/services/file-system.service';
import { GameEngineService } from '../../core/services/game-engine.service';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { MatDialog } from '@angular/material/dialog';
import { GameStateService } from '../../core/services/game-state.service';

/** Dialog data interface for multi-file viewer */
export interface FileViewerDialogData {
  /** All files to load: filename -> content */
  files: Map<string, string>;
  /** Initially selected file name */
  initialFile: string;
  /** Whether to start in edit mode */
  editMode?: boolean;
}

/** Search result interface */
export interface SearchResult {
  fileName: string;
  lineNumber: number;
  lineContent: string;
  matchIndex: number;
  matchLength: number;
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
    MonacoEditorComponent
  ],
  templateUrl: './file-viewer-dialog.component.html',
  styleUrl: './file-viewer-dialog.component.scss'
})
export class FileViewerDialogComponent implements OnDestroy {
  data = inject(MAT_DIALOG_DATA) as FileViewerDialogData;
  private dialogRef = inject(MatDialogRef<FileViewerDialogComponent>);
  private fileSystem = inject(FileSystemService);
  private engine = inject(GameEngineService);
  private state = inject(GameStateService);
  private snackBar = inject(MatSnackBar);
  private matDialog = inject(MatDialog);

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

  // Sidebar view mode: 'files' or 'search'
  sidebarView = signal<'files' | 'search'>('files');

  // Search state
  searchQuery = signal('');
  // searchResults & isSearching removed in favor of searchResource

  // Replace state
  replaceQuery = signal('');
  isReplaceExpanded = signal(false);
  isReplacing = signal(false);

  // VS Code-like search options
  isRegex = signal(false);
  isWholeWord = signal(false);
  isCaseSensitive = signal(false);

  // Collapse state for file groups in search results
  collapsedFiles = signal<Set<string>>(new Set());

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

    const headers: MarkdownHeader[] = [];
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      const match = line.trimEnd().match(/^(#{1,6})\s+(.+)$/);
      if (match) {
        headers.push({
          level: match[1].length,
          text: match[2].trim(),
          lineNumber: index + 1
        });
      }
    });
    return headers;
  });

  // Monaco editor options - always allowing editing now
  editorOptions = computed(() => ({
    readOnly: false,
    minimap: { enabled: false }
  }));

  // Resource API transformation for search
  searchResource = resource({
    params: () => ({
      query: this.searchQuery(),
      regex: this.isRegex(),
      wholeWord: this.isWholeWord(),
      caseSensitive: this.isCaseSensitive(),
    }),
    loader: async ({ params }) => {
      const query = params.query.trim();
      if (!query) {
        return [];
      }

      // Wrap synchronous search in a promise to satisfy resource loader contract
      return new Promise<SearchResult[]>((resolve) => {
        // Small delay to prevent UI freezing on large searches and allow UI to show loading state
        setTimeout(() => {
          const results: SearchResult[] = [];
          try {
            let searchPattern: RegExp;

            if (params.regex) {
              try {
                searchPattern = new RegExp(query, params.caseSensitive ? 'g' : 'gi');
              } catch {
                // Invalid regex, treat as literal
                const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                searchPattern = new RegExp(escaped, params.caseSensitive ? 'g' : 'gi');
              }
            } else {
              // Escape special chars for literal search
              let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              if (params.wholeWord) {
                escaped = `\\b${escaped}\\b`;
              }
              searchPattern = new RegExp(escaped, params.caseSensitive ? 'g' : 'gi');
            }

            this.data.files.forEach((content, fileName) => {
              const lines = content.split('\n');
              lines.forEach((line, index) => {
                let match: RegExpExecArray | null;
                searchPattern.lastIndex = 0; // Reset for global regex
                while ((match = searchPattern.exec(line)) !== null) {
                  results.push({
                    fileName,
                    lineNumber: index + 1,
                    lineContent: line.trim().substring(0, 100), // Truncate long lines
                    matchIndex: match.index,
                    matchLength: match[0].length
                  });
                }
              });
            });
            resolve(results);
          } catch (err) {
            console.error('Search validation error', err);
            resolve([]);
          }
        }, 0);
      });
    }
  });

  // Group search results by file
  groupedSearchResults = computed(() => {
    const results = this.searchResource.value() ?? [];
    const groups = new Map<string, SearchResult[]>();

    results.forEach(result => {
      if (!groups.has(result.fileName)) {
        groups.set(result.fileName, []);
      }
      groups.get(result.fileName)!.push(result);
    });

    // Sort files by name
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  });

  // Store decoration collection for cleanup
  private decorationsCollection: import('monaco-editor').editor.IEditorDecorationsCollection | null = null;

  constructor() {
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

    // Start in edit mode if requested (always true now, but keeping for compatibility)
    if (this.data.editMode && this.canEdit()) {
      // isEditing removed
    }

    // Effect to sync content when active file changes
    effect(() => {
      const fileName = this.activeFile();
      const initialContent = this.data.files.get(fileName) || '';
      this.activeFileContent.set(initialContent);
    });

    // Effect to highlight matches when search results or active file changes
    effect(() => {
      const results: SearchResult[] = this.searchResource.value() ?? [];
      const activeFileName = this.activeFile();
      // Trigger effect on editor initialization
      void this.editorRef();

      // Delay to ensure editor is ready after file switch
      setTimeout(() => this.highlightMatches(results, activeFileName), 150);
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

  /** Toggle regex option */
  toggleRegex(): void {
    this.isRegex.update(v => !v);
  }

  /** Toggle whole word option */
  toggleWholeWord(): void {
    this.isWholeWord.update(v => !v);
  }

  /** Toggle case sensitive option */
  toggleCaseSensitive(): void {
    this.isCaseSensitive.update(v => !v);
  }

  /** Toggle replace input visibility */
  toggleReplaceExpanded(): void {
    this.isReplaceExpanded.update(v => !v);
  }

  /** Toggle collapse state of a file in search results */
  toggleFileCollapse(fileName: string): void {
    this.collapsedFiles.update(set => {
      const next = new Set(set);
      if (next.has(fileName)) {
        next.delete(fileName);
      } else {
        next.add(fileName);
      }
      return next;
    });
  }

  /** Replace match in a specific file at a specific position */
  async replaceInFile(result: SearchResult): Promise<void> {
    const content = this.data.files.get(result.fileName);
    if (!content) return;

    const lines = content.split('\n');
    const lineIndex = result.lineNumber - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) return;

    const line = lines[lineIndex];
    const replaceWith = this.replaceQuery();
    const query = this.searchQuery();

    // Build the same search pattern used in search
    let searchPattern: RegExp;
    if (this.isRegex()) {
      try {
        // Non-global for single replacement
        searchPattern = new RegExp(query, this.isCaseSensitive() ? '' : 'i');
      } catch {
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        searchPattern = new RegExp(escaped, this.isCaseSensitive() ? '' : 'i');
      }
    } else {
      let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (this.isWholeWord()) {
        escaped = `\\b${escaped}\\b`;
      }
      searchPattern = new RegExp(escaped, this.isCaseSensitive() ? '' : 'i');
    }

    // Replace the specific occurrence at matchIndex
    const before = line.substring(0, result.matchIndex);
    const after = line.substring(result.matchIndex);
    const newAfter = after.replace(searchPattern, replaceWith);
    lines[lineIndex] = before + newAfter;

    const newContent = lines.join('\n');
    this.data.files.set(result.fileName, newContent);

    // Update Monaco model via editor component
    const editor = this.editorRef();
    if (editor) {
      editor.updateFileContent(result.fileName, newContent);
    }

    // Re-run search to update results
    this.searchResource.reload();
  }

  /** Replace all matches across all files */
  async replaceAllMatches(): Promise<void> {
    const results: SearchResult[] = this.searchResource.value() ?? [];
    if (results.length === 0) return;

    this.isReplacing.set(true);
    try {
      const query = this.searchQuery();
      const replaceWith = this.replaceQuery();

      // Build global search pattern
      let searchPattern: RegExp;
      if (this.isRegex()) {
        try {
          searchPattern = new RegExp(query, this.isCaseSensitive() ? 'g' : 'gi');
        } catch {
          const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          searchPattern = new RegExp(escaped, this.isCaseSensitive() ? 'g' : 'gi');
        }
      } else {
        let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (this.isWholeWord()) {
          escaped = `\\b${escaped}\\b`;
        }
        searchPattern = new RegExp(escaped, this.isCaseSensitive() ? 'g' : 'gi');
      }

      // Group results by file and replace all occurrences in each file
      const affectedFiles = new Set(results.map(r => r.fileName));
      const editor = this.editorRef();

      for (const fileName of affectedFiles) {
        const content = this.data.files.get(fileName);
        if (!content) continue;

        const newContent = content.replace(searchPattern, replaceWith);
        this.data.files.set(fileName, newContent);

        // Update Monaco model
        if (editor) {
          editor.updateFileContent(fileName, newContent);
        }
      }

      // Re-run search (should now return empty)
      this.searchResource.reload();

      this.snackBar.open(`Replaced ${results.length} occurrences in ${affectedFiles.size} file(s)`, 'Close', { duration: 3000 });
    } finally {
      this.isReplacing.set(false);
    }
  }

  /** Generate HTML content with highlighted match for preview */
  getHighlightedContent(result: SearchResult): string {
    // Get the original line (not trimmed) to find the match
    const originalLine = this.data.files.get(result.fileName)?.split('\n')[result.lineNumber - 1] || '';
    const matchStart = result.matchIndex;
    const matchEnd = matchStart + result.matchLength;

    // Show minimal context around the match to fit narrow sidebar
    const contextBefore = 20;
    const contextAfter = 100;
    const start = Math.max(0, matchStart - contextBefore);
    const end = Math.min(originalLine.length, matchEnd + contextAfter);

    // Build the preview string with highlight
    const prefix = start > 0 ? '...' : '';
    const suffix = end < originalLine.length ? '...' : '';

    const before = originalLine.substring(start, matchStart);
    const match = originalLine.substring(matchStart, matchEnd);
    const after = originalLine.substring(matchEnd, end);

    return `${prefix}${this.escapeHtml(before)}<span class="match-highlight">${this.escapeHtml(match)}</span>${this.escapeHtml(after)}${suffix}`;
  }

  /** Generate HTML content with replacement preview */
  getReplacePreview(result: SearchResult): string {
    const originalLine = this.data.files.get(result.fileName)?.split('\n')[result.lineNumber - 1] || '';
    const query = this.searchQuery();
    const replaceWith = this.replaceQuery();

    let searchPattern: RegExp;
    try {
      if (this.isRegex()) {
        searchPattern = new RegExp(query, this.isCaseSensitive() ? '' : 'i');
      } else {
        let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (this.isWholeWord()) {
          escaped = `\\b${escaped}\\b`;
        }
        searchPattern = new RegExp(escaped, this.isCaseSensitive() ? '' : 'i');
      }

      const matchStart = result.matchIndex;
      const matchEnd = matchStart + result.matchLength;

      const match = originalLine.substring(matchStart, matchEnd);

      // Perform the replacement on just the match part to see what it becomes
      const substitutedMatch = match.replace(searchPattern, replaceWith);

      // Show minimal context
      const contextBefore = 10;
      const contextAfter = 15;
      const start = Math.max(0, matchStart - contextBefore);
      const end = Math.min(originalLine.length, matchEnd + contextAfter);

      const prefix = start > 0 ? '...' : '';
      const suffix = end < originalLine.length ? '...' : '';

      const previewBefore = originalLine.substring(start, matchStart);
      const previewAfter = originalLine.substring(matchEnd, Math.min(originalLine.length, matchEnd + contextAfter));

      return `${prefix}${this.escapeHtml(previewBefore)}<span class="replace-preview-text">${this.escapeHtml(substitutedMatch)}</span>${this.escapeHtml(previewAfter)}${suffix}`;
    } catch {
      return 'Invalid Regex';
    }
  }

  /** Generate combined diff-style HTML for replace preview */
  getCombinedDiffPreview(result: SearchResult): string {
    const originalLine = this.data.files.get(result.fileName)?.split('\n')[result.lineNumber - 1] || '';
    const query = this.searchQuery();
    const replaceWith = this.replaceQuery();

    let searchPattern: RegExp;
    try {
      if (this.isRegex()) {
        searchPattern = new RegExp(query, this.isCaseSensitive() ? '' : 'i');
      } else {
        let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (this.isWholeWord()) {
          escaped = `\\b${escaped}\\b`;
        }
        searchPattern = new RegExp(escaped, this.isCaseSensitive() ? '' : 'i');
      }

      const matchStart = result.matchIndex;
      const matchEnd = matchStart + result.matchLength;

      const prefix_len = 20;
      const suffix_len = 100;
      const start = Math.max(0, matchStart - prefix_len);
      const end = Math.min(originalLine.length, matchEnd + suffix_len);

      const prefix = start > 0 ? '...' : '';
      const suffix = end < originalLine.length ? '...' : '';

      const beforeMatch = originalLine.substring(start, matchStart);
      const match = originalLine.substring(matchStart, matchEnd);
      const afterMatch = originalLine.substring(matchEnd, end);

      const substitutedMatch = match.replace(searchPattern, replaceWith);

      return `${prefix}${this.escapeHtml(beforeMatch)}<span class="diff-removed">${this.escapeHtml(match)}</span><span class="diff-added">${this.escapeHtml(substitutedMatch)}</span>${this.escapeHtml(afterMatch)}${suffix}`;
    } catch {
      return 'Invalid Regex';
    }
  }

  /** Escape HTML special characters */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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

    // Update activeFileContent for the new file
    const newInitialContent = this.data.files.get(fileName) || '';
    // If it was already modified, Monaco will have the modified version, 
    // but the outline needs the content. Monaco handles model switching.
    // We should probably get the value from Monaco models if available.
    if (editor) {
      const existingModelContent = editor.getFileContent(fileName);
      if (existingModelContent !== undefined) {
        this.activeFileContent.set(existingModelContent);
      } else {
        this.activeFileContent.set(newInitialContent);
      }
    }

    // Collapse sidebar on mobile after selection
    if (window.innerWidth < 768) {
      this.isSidebarCollapsed.set(true);
    }
  }

  /** Handle value changes from Monaco */
  onValueChange(newValue: string): void {
    this.activeFileContent.set(newValue);
    const fileName = this.activeFile();
    const originalContent = this.data.files.get(fileName) || '';

    this.unsavedFiles.update((set: Set<string>) => {
      const next = new Set(set);
      if (newValue !== originalContent) {
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

      await this.fileSystem.writeTextFile(fileName, content);
      // Refresh counts and memory
      await this.engine.loadFiles(false);

      this.snackBar.open('File saved successfully!', 'Close', { duration: 3000 });
      // Update the local data map
      this.data.files.set(fileName, content);
      // Remove from unsaved files
      this.unsavedFiles.update((set: Set<string>) => {
        const next = new Set(set);
        next.delete(fileName);
        return next;
      });
    } catch (err) {
      console.error('Save failed:', err);
      this.snackBar.open('Failed to save file.', 'Close', { duration: 5000 });
    } finally {
      this.isSaving.set(false);
    }
  }

  /** Close the dialog */
  async close(): Promise<void> {
    if (this.unsavedFiles().size > 0) {
      const ref = this.matDialog.open(ConfirmDialogComponent, {
        data: {
          title: 'Unsaved Changes',
          message: `You have unsaved changes in ${this.unsavedFiles().size} file(s). Are you sure you want to leave?`,
          okText: 'Leave',
          cancelText: 'Stay'
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
  }
}
