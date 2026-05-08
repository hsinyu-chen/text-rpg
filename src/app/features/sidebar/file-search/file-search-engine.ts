import { Injectable, computed, resource, signal } from '@angular/core';
import {
  type SearchResult,
  applyReplacementAt,
  buildSearchPatternOrLiteral,
  effectiveRegexMode,
  escapeReplacement,
  findMatchesInLines,
  formatCombinedDiffPreview,
  formatHighlightedSnippet,
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
  /** Cached split-by-line view per file. Invalidated when content drifts from `content`. */
  private linesCache = new Map<string, { content: string; lines: string[] }>();

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
    loader: async ({ params, abortSignal }) => {
      if (!params.query) return [];
      // setTimeout(0) lets the loading state paint before the synchronous walk;
      // abortSignal lets a fast typist's earlier loaders short-circuit instead
      // of running the walk against stale params.
      return new Promise<SearchResult[]>((resolve) => {
        setTimeout(() => {
          if (abortSignal.aborted) {
            resolve([]);
            return;
          }
          try {
            resolve(findMatchesInLines(this.getLinesPerFile(), params));
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

    const opts = this.currentOptions();
    const pattern = buildSearchPatternOrLiteral(opts, false);
    const replaceWith = escapeReplacement(this.replaceQuery(), effectiveRegexMode(opts));
    const matchEnd = result.matchIndex + result.matchLength;
    const { newLine } = applyReplacementAt(lines[lineIndex], result.matchIndex, matchEnd, pattern, replaceWith);
    lines[lineIndex] = newLine;

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
    // Yield once so the [disabled] state on the Replace All button paints
    // before the synchronous string-replace work starts.
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const opts = this.currentOptions();
      const pattern = buildSearchPatternOrLiteral(opts, true);
      const replaceWith = escapeReplacement(this.replaceQuery(), effectiveRegexMode(opts));
      const affected = new Set(results.map((r) => r.fileName));

      for (const fileName of affected) {
        const content = this.files.get(fileName);
        if (!content) continue;
        // Replace per line — mirrors the per-line search loop so patterns like
        // `\s+` or `\W+` cannot consume newlines and silently merge lines.
        const newLines = this.linesFor(fileName, content).map((line) => line.replace(pattern, replaceWith));
        const newContent = newLines.join('\n');
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

  getCombinedDiffPreview(result: SearchResult): string {
    const line = this.lineFor(result);
    // Match search/replace's literal fallback: an invalid regex still highlights
    // the literal hits the result list shows — the diff would otherwise read
    // 'Invalid Regex' for entries that DO have a working literal replacement.
    const opts = this.currentOptions();
    const pattern = buildSearchPatternOrLiteral(opts, false);
    const replaceWith = escapeReplacement(this.replaceQuery(), effectiveRegexMode(opts));
    return formatCombinedDiffPreview(line, result.matchIndex, result.matchIndex + result.matchLength, pattern, replaceWith);
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
    const content = this.files.get(result.fileName);
    if (content === undefined) return '';
    return this.linesFor(result.fileName, content)[result.lineNumber - 1] ?? '';
  }

  private linesFor(fileName: string, content: string): string[] {
    const cached = this.linesCache.get(fileName);
    if (cached?.content === content) return cached.lines;
    const lines = content.split('\n');
    this.linesCache.set(fileName, { content, lines });
    return lines;
  }

  /** Snapshot of all files as pre-split lines, reusing the lines cache where possible. */
  private getLinesPerFile(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    this.files.forEach((content, fileName) => out.set(fileName, this.linesFor(fileName, content)));
    return out;
  }
}
