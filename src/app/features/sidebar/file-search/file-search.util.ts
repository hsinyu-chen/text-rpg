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
  // No `m` flag: every consumer of this pattern operates on individual lines
  // (search splits via Map<file, string[]>; replaceAll maps replace per line),
  // so `^` and `$` already mean line anchors. `m` would be silently no-op and
  // misleadingly suggest cross-line matching is supported.
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

/**
 * Whether `opts.regex` is honoured or silently downgraded to literal mode.
 *
 * `buildSearchPatternOrLiteral` swallows invalid regex syntax — the resulting
 * pattern then matches escaped literals. Callers that build a replacement
 * string need this signal to escape `$` correctly: literal mode requires
 * `$$` to emit `$`; regex mode preserves substitution tokens like `$&` / `$1`.
 */
export function effectiveRegexMode(opts: SearchOptions): boolean {
  if (!opts.regex) return false;
  try {
    new RegExp(opts.query);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace the match at `[matchStart, matchEnd)` on `line`, preserving full
 * regex context (lookbehinds, `\B`, `$\`` / `$'` substitution tokens).
 *
 * Uses a sticky (`y`) regex anchored at `matchStart` and runs replace against
 * the full line — the prior `line.substring(matchStart).replace(...)` approach
 * silently dropped left context, breaking those features.
 *
 * Returns both the rewritten line and the substituted slice (useful for
 * preview rendering). Substituted slice is derived from length math; no second
 * replace pass needed.
 */
export function applyReplacementAt(
  line: string,
  matchStart: number,
  matchEnd: number,
  pattern: RegExp,
  replaceWith: string,
): { newLine: string; substituted: string } {
  const stickyFlags = pattern.flags.replace(/[gy]/g, '') + 'y';
  const sticky = new RegExp(pattern.source, stickyFlags);
  sticky.lastIndex = matchStart;
  const newLine = line.replace(sticky, replaceWith);
  // newLine.length = line.length - (matchEnd - matchStart) + substituted.length
  const subLen = newLine.length - line.length + (matchEnd - matchStart);
  return { newLine, substituted: newLine.substring(matchStart, matchStart + subLen) };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Walk every line of every file with a global pattern, collecting matches.
 *
 * Takes pre-split lines (not raw content) so the engine can reuse its own
 * lines cache instead of re-splitting on each search trigger.
 */
export function findMatchesInLines(
  linesByFile: Map<string, string[]>,
  opts: SearchOptions,
): SearchResult[] {
  if (!opts.query) return [];

  const pattern = buildSearchPatternOrLiteral(opts, true);
  const results: SearchResult[] = [];

  linesByFile.forEach((lines, fileName) => {
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
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape `$` in a replacement string for literal-mode `.replace()` calls.
 *
 * `String.prototype.replace` treats `$$`, `$&`, `$\``, `$'`, `$<n>` as special
 * substitution patterns. In literal search mode the user expects `$` to mean
 * a `$` character — double every `$` so the substitution engine emits one.
 * Regex mode passes through verbatim so users keep access to `$1`, `$&`, etc.
 */
export function escapeReplacement(replaceWith: string, isRegex: boolean): string {
  return isRegex ? replaceWith : replaceWith.replace(/\$/g, '$$$$');
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
  // Substitute against the full line so lookbehinds, \B, and $`/$' tokens
  // see the actual surrounding context — c.match alone has none.
  const { substituted } = applyReplacementAt(line, matchStart, matchEnd, pattern, replaceWith);
  return `${c.prefix}${escapeHtml(c.before)}<span class="diff-removed">${escapeHtml(c.match)}</span><span class="diff-added">${escapeHtml(substituted)}</span>${escapeHtml(c.after)}${c.suffix}`;
}
