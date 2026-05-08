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
  // `m` flag aligns the file-wide `replaceAllMatches` pass with the per-line
  // search loop: `^` / `$` mean line anchors in both, otherwise users would
  // see N preview hits but only the file-start match would replace.
  const flags = (global ? 'gm' : '') + (caseSensitive ? '' : 'i');
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
  if (!opts.query) return [];

  const pattern = buildSearchPatternOrLiteral(opts, true);
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
          matchIndex: match.index,
          matchLength: match[0].length,
        });
        // Zero-width matches (`^`, `$`, `a*`) leave lastIndex unchanged and
        // would loop forever without manual advancement.
        if (match[0].length === 0) pattern.lastIndex += 1;
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

interface SnippetClip {
  /** '...' if context truncates on the left, '' otherwise */
  prefix: string;
  /** '...' if context truncates on the right, '' otherwise */
  suffix: string;
  before: string;
  match: string;
  after: string;
}

/** Slice a fixed window of context around a match for sidebar previews. */
function clipSnippetWindow(
  line: string,
  matchStart: number,
  matchEnd: number,
  ctxBefore: number,
  ctxAfter: number,
): SnippetClip {
  const start = Math.max(0, matchStart - ctxBefore);
  const end = Math.min(line.length, matchEnd + ctxAfter);
  return {
    prefix: start > 0 ? '...' : '',
    suffix: end < line.length ? '...' : '',
    before: line.substring(start, matchStart),
    match: line.substring(matchStart, matchEnd),
    after: line.substring(matchEnd, end),
  };
}

/** Render `...before<span class="match-highlight">match</span>after...` for a sidebar preview. */
export function formatHighlightedSnippet(
  line: string,
  matchStart: number,
  matchEnd: number,
  ctxBefore = 20,
  ctxAfter = 100,
): string {
  const c = clipSnippetWindow(line, matchStart, matchEnd, ctxBefore, ctxAfter);
  return `${c.prefix}${escapeHtml(c.before)}<span class="match-highlight">${escapeHtml(c.match)}</span>${escapeHtml(c.after)}${c.suffix}`;
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
  const c = clipSnippetWindow(line, matchStart, matchEnd, ctxBefore, ctxAfter);
  const substituted = c.match.replace(pattern, replaceWith);
  return `${c.prefix}${escapeHtml(c.before)}<span class="diff-removed">${escapeHtml(c.match)}</span><span class="diff-added">${escapeHtml(substituted)}</span>${escapeHtml(c.after)}${c.suffix}`;
}
