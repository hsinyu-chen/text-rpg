/**
 * Pure helpers for VS Code-style search/replace inside the file viewer dialog.
 *
 * Decoupled from Angular: takes file maps + options as input, returns matches /
 * preview HTML. The Angular-aware orchestration (signals, resource, decorations)
 * lives in {@link FileSearchEngine}.
 */

export interface SearchResult {
  fileName: string;
  lineNumber: number;
  /** Trimmed + truncated for sidebar display; not used for preview rendering. */
  lineContent: string;
  matchIndex: number;
  matchLength: number;
}

export interface SearchOptions {
  query: string;
  regex: boolean;
  wholeWord: boolean;
  caseSensitive: boolean;
}

/**
 * Build the RegExp used for matching.
 *
 * `global` controls whether to set the `g` flag — search loop needs `g` to walk
 * all occurrences with `exec`; single-replacement preview / replaceInFile need
 * non-global so `String.replace` only swaps the first match.
 *
 * Throws if `opts.regex` is true and the query is not a valid RegExp source —
 * callers decide whether to fall back to a literal pattern (search/replace
 * paths do; preview paths surface 'Invalid Regex' instead).
 */
export function buildSearchPattern(opts: SearchOptions, global: boolean): RegExp {
  const { query, regex, wholeWord, caseSensitive } = opts;
  const flags = (global ? 'g' : '') + (caseSensitive ? '' : 'i');
  if (regex) return new RegExp(query, flags);
  let escaped = escapeRegex(query);
  if (wholeWord) escaped = `\\b${escaped}\\b`;
  return new RegExp(escaped, flags);
}

/** Like {@link buildSearchPattern} but falls back to a literal-escaped pattern on invalid regex. */
export function buildSearchPatternOrLiteral(opts: SearchOptions, global: boolean): RegExp {
  try {
    return buildSearchPattern(opts, global);
  } catch {
    return buildSearchPattern({ ...opts, regex: false, wholeWord: false }, global);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Walk every line of every file with a global pattern, collecting matches. */
export function findMatchesInFiles(
  files: Map<string, string>,
  opts: SearchOptions,
): SearchResult[] {
  const trimmed = opts.query.trim();
  if (!trimmed) return [];

  const pattern = buildSearchPatternOrLiteral({ ...opts, query: trimmed }, true);
  const results: SearchResult[] = [];

  files.forEach((content, fileName) => {
    const lines = content.split('\n');
    lines.forEach((line, index) => {
      let match: RegExpExecArray | null;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(line)) !== null) {
        results.push({
          fileName,
          lineNumber: index + 1,
          lineContent: line.trim().substring(0, 100),
          matchIndex: match.index,
          matchLength: match[0].length,
        });
      }
    });
  });

  return results;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render `...before<span class="match-highlight">match</span>after...` for a sidebar preview. */
export function formatHighlightedSnippet(
  line: string,
  matchStart: number,
  matchEnd: number,
  ctxBefore = 20,
  ctxAfter = 100,
): string {
  const start = Math.max(0, matchStart - ctxBefore);
  const end = Math.min(line.length, matchEnd + ctxAfter);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < line.length ? '...' : '';

  const before = line.substring(start, matchStart);
  const match = line.substring(matchStart, matchEnd);
  const after = line.substring(matchEnd, end);

  return `${prefix}${escapeHtml(before)}<span class="match-highlight">${escapeHtml(match)}</span>${escapeHtml(after)}${suffix}`;
}

/** Render the substituted text for a single match (replace preview, no diff styling). */
export function formatReplacePreview(
  line: string,
  matchStart: number,
  matchEnd: number,
  pattern: RegExp,
  replaceWith: string,
  ctxBefore = 10,
  ctxAfter = 15,
): string {
  const match = line.substring(matchStart, matchEnd);
  const substituted = match.replace(pattern, replaceWith);

  const start = Math.max(0, matchStart - ctxBefore);
  const end = Math.min(line.length, matchEnd + ctxAfter);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < line.length ? '...' : '';

  const previewBefore = line.substring(start, matchStart);
  const previewAfter = line.substring(matchEnd, end);

  return `${prefix}${escapeHtml(previewBefore)}<span class="replace-preview-text">${escapeHtml(substituted)}</span>${escapeHtml(previewAfter)}${suffix}`;
}

/** Render `before<del>old</del><ins>new</ins>after` style diff for replace preview. */
export function formatCombinedDiffPreview(
  line: string,
  matchStart: number,
  matchEnd: number,
  pattern: RegExp,
  replaceWith: string,
  ctxBefore = 20,
  ctxAfter = 100,
): string {
  const start = Math.max(0, matchStart - ctxBefore);
  const end = Math.min(line.length, matchEnd + ctxAfter);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < line.length ? '...' : '';

  const beforeMatch = line.substring(start, matchStart);
  const match = line.substring(matchStart, matchEnd);
  const afterMatch = line.substring(matchEnd, end);
  const substituted = match.replace(pattern, replaceWith);

  return `${prefix}${escapeHtml(beforeMatch)}<span class="diff-removed">${escapeHtml(match)}</span><span class="diff-added">${escapeHtml(substituted)}</span>${escapeHtml(afterMatch)}${suffix}`;
}
