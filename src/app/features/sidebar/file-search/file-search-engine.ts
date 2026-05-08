import { Injectable, computed, resource, signal } from '@angular/core';
import {
  type SearchResult,
  buildSearchPattern,
  buildSearchPatternOrLiteral,
  findMatchesInFiles,
  formatCombinedDiffPreview,
  formatHighlightedSnippet,
  formatReplacePreview,
} from './file-search.util';

export type { SearchResult } from './file-search.util';

/**
 * Per-dialog state for VS Code-style search/replace.
 *
 * Provided in the FileViewerDialog component's `providers` array so each dialog
 * gets its own instance. {@link bind} wires it to the live file map + a callback
 * the dialog uses to push replacements into the Monaco editor.
 */
@Injectable()
export class FileSearchEngine {
  searchQuery = signal('');
  replaceQuery = signal('');

  isRegex = signal(false);
  isWholeWord = signal(false);
  isCaseSensitive = signal(false);
  isReplaceExpanded = signal(false);
  isReplacing = signal(false);

  collapsedFiles = signal<Set<string>>(new Set());

  private files = new Map<string, string>();
  private onFileChanged?: (fileName: string, content: string) => void;

  /** Wire the engine to the live file map + Monaco-update callback. */
  bind(files: Map<string, string>, onFileChanged: (fileName: string, content: string) => void): void {
    this.files = files;
    this.onFileChanged = onFileChanged;
  }

  searchResource = resource({
    params: () => ({
      query: this.searchQuery(),
      regex: this.isRegex(),
      wholeWord: this.isWholeWord(),
      caseSensitive: this.isCaseSensitive(),
    }),
    loader: async ({ params }) => {
      const query = params.query.trim();
      if (!query) return [];
      // setTimeout(0) lets the loading state paint before the synchronous walk.
      return new Promise<SearchResult[]>((resolve) => {
        setTimeout(() => {
          try {
            resolve(findMatchesInFiles(this.files, params));
          } catch (err) {
            console.error('Search validation error', err);
            resolve([]);
          }
        }, 0);
      });
    },
  });

  groupedSearchResults = computed(() => {
    const results = this.searchResource.value() ?? [];
    const groups = new Map<string, SearchResult[]>();
    for (const result of results) {
      const list = groups.get(result.fileName);
      if (list) list.push(result);
      else groups.set(result.fileName, [result]);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  });

  toggleRegex(): void { this.isRegex.update((v) => !v); }
  toggleWholeWord(): void { this.isWholeWord.update((v) => !v); }
  toggleCaseSensitive(): void { this.isCaseSensitive.update((v) => !v); }
  toggleReplaceExpanded(): void { this.isReplaceExpanded.update((v) => !v); }

  toggleFileCollapse(fileName: string): void {
    this.collapsedFiles.update((set) => {
      const next = new Set(set);
      if (next.has(fileName)) next.delete(fileName);
      else next.add(fileName);
      return next;
    });
  }

  /** Replace a single match. Mutates the file map; caller's onFileChanged pushes to Monaco. */
  replaceInFile(result: SearchResult): void {
    const content = this.files.get(result.fileName);
    if (!content) return;

    const lines = content.split('\n');
    const lineIndex = result.lineNumber - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) return;

    const line = lines[lineIndex];
    const pattern = buildSearchPatternOrLiteral(this.currentOptions(), false);
    const replaceWith = this.replaceQuery();

    const before = line.substring(0, result.matchIndex);
    const after = line.substring(result.matchIndex);
    lines[lineIndex] = before + after.replace(pattern, replaceWith);

    const newContent = lines.join('\n');
    this.files.set(result.fileName, newContent);
    this.onFileChanged?.(result.fileName, newContent);
    this.searchResource.reload();
  }

  /** Replace every match across all affected files. Returns counts for snackbar. */
  async replaceAllMatches(): Promise<{ replaced: number; files: number }> {
    const results = this.searchResource.value() ?? [];
    if (results.length === 0) return { replaced: 0, files: 0 };

    this.isReplacing.set(true);
    try {
      const pattern = buildSearchPatternOrLiteral(this.currentOptions(), true);
      const replaceWith = this.replaceQuery();
      const affected = new Set(results.map((r) => r.fileName));

      for (const fileName of affected) {
        const content = this.files.get(fileName);
        if (!content) continue;
        const newContent = content.replace(pattern, replaceWith);
        this.files.set(fileName, newContent);
        this.onFileChanged?.(fileName, newContent);
      }

      this.searchResource.reload();
      return { replaced: results.length, files: affected.size };
    } finally {
      this.isReplacing.set(false);
    }
  }

  getHighlightedContent(result: SearchResult): string {
    const line = this.lineFor(result);
    return formatHighlightedSnippet(line, result.matchIndex, result.matchIndex + result.matchLength);
  }

  getReplacePreview(result: SearchResult): string {
    const line = this.lineFor(result);
    try {
      const pattern = buildSearchPattern(this.currentOptions(), false);
      return formatReplacePreview(line, result.matchIndex, result.matchIndex + result.matchLength, pattern, this.replaceQuery());
    } catch {
      return 'Invalid Regex';
    }
  }

  getCombinedDiffPreview(result: SearchResult): string {
    const line = this.lineFor(result);
    try {
      const pattern = buildSearchPattern(this.currentOptions(), false);
      return formatCombinedDiffPreview(line, result.matchIndex, result.matchIndex + result.matchLength, pattern, this.replaceQuery());
    } catch {
      return 'Invalid Regex';
    }
  }

  private currentOptions() {
    return {
      query: this.searchQuery(),
      regex: this.isRegex(),
      wholeWord: this.isWholeWord(),
      caseSensitive: this.isCaseSensitive(),
    };
  }

  private lineFor(result: SearchResult): string {
    return this.files.get(result.fileName)?.split('\n')[result.lineNumber - 1] ?? '';
  }
}
