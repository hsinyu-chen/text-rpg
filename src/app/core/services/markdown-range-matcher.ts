import { computeFencedLineMask, parseAtxHeading } from '../utils/markdown.util';

/**
 * Markdown range/anchor matcher tuned for LLM-generated update hunks.
 *
 * Distinct from `markdown-section.util.ts` (which file-agent uses): that one
 * is strict equality + ambiguous-refuse for tool-driven edits; this one is
 * loose `includes` + tolerates `# count mismatch` because the LLM's `target`
 * and `context` strings are approximate.
 */

interface ParsedCrumb {
    text: string;
    isStrictHeader: boolean;
}

function parseCrumb(crumb: string): ParsedCrumb {
    const headerMatch = crumb.match(/^(#+)\s*(.*)/);
    return headerMatch
        ? { text: headerMatch[2], isStrictHeader: true }
        : { text: crumb, isStrictHeader: false };
}

/**
 * Test a single line against a parsed crumb. Fence-aware on heading parse
 * only — when `fenced` is true, the line cannot register as a heading, but
 * loose body-text `includes` matching still runs. Callers that need to skip
 * fenced lines outright (e.g. `findInsertionPoint`) pre-filter before
 * calling.
 */
function matchCrumb(line: string, fenced: boolean, crumb: ParsedCrumb): boolean {
    const lineHeading = fenced ? null : parseAtxHeading(line);
    const isLineHeader = !!lineHeading;
    const lineText = lineHeading ? lineHeading.text : line.trim();
    const normalizedLine = normalizeForComparison(lineText);
    const normalizedCrumb = normalizeForComparison(crumb.text);

    if (!normalizedLine.includes(normalizedCrumb)) return false;
    if (crumb.isStrictHeader && !isLineHeader) return false;
    return true;
}

/**
 * Strip CJK punctuation to ASCII equivalents and remove whitespace + hashes
 * so the LLM's approximate target text matches the original despite
 * formatting drift. The `[#\s]` removal is what `mapNormalizedIndexToOriginal`
 * relies on to map back — keep them in sync.
 */
export function normalizeForComparison(line: string): string {
    if (!line) return '';
    return line
        .replace(/：/g, ':')
        .replace(/（/g, '(')
        .replace(/）/g, ')')
        .replace(/，/g, ',')
        .replace(/。/g, '.')
        .replace(/！/g, '!')
        .replace(/？/g, '?')
        .replace(/—/g, '-')
        .replace(/[#\s]/g, '');
}

/**
 * Stateful walker that maps indices in the normalized string back to the
 * original. Resumes from the previous query position so a series of
 * forward-moving lookups (the typical `findMatchRange` pattern) costs O(N)
 * total instead of O(N*queries). Backward queries (which happen because
 * `searchStart = normalizedIndex + 1` permits overlapping matches) reset
 * the cursor and rescan from the start — correct, and at worst
 * O(N) per overlap.
 *
 * Relies on `normalizeForComparison` either dropping a character (matched
 * by `[#\s]`) or keeping it 1:1 — any future multi-char or surrogate-pair
 * replacement in normalizeForComparison would desync this mapping and
 * silently corrupt file edits, so the two MUST evolve together.
 */
export function createIndexMapper(original: string): (normalizedIndex: number) => number {
    let pos = 0;
    let normalizedCount = 0;
    return (normalizedIndex: number): number => {
        if (normalizedIndex < normalizedCount) {
            pos = 0;
            normalizedCount = 0;
        }
        while (pos < original.length) {
            if (!/[#\s]/.test(original[pos])) {
                if (normalizedCount === normalizedIndex) return pos;
                normalizedCount++;
            }
            pos++;
        }
        return original.length;
    };
}

export function getLineIndexFromCharIndex(content: string, charIndex: number): number {
    const before = content.substring(0, charIndex);
    return before.split(/\r?\n/).length - 1;
}

/**
 * Expand a target match over leading/trailing whitespace + hashes if the
 * target itself starts/ends with `#` (LLM signaled header intent).
 */
function expandRange(content: string, target: string, start: number, end: number): { start: number; end: number } {
    const expandLeft = target.startsWith('#');
    const expandRight = target.endsWith('#');

    let newStart = start;
    let newEnd = end;

    if (expandLeft) {
        while (newStart > 0 && /[#\t ]/.test(content[newStart - 1])) {
            newStart--;
        }
    }
    if (expandRight) {
        while (newEnd < content.length && /[#\t ]/.test(content[newEnd])) {
            newEnd++;
        }
    }

    return { start: newStart, end: newEnd };
}

/**
 * Verify that a context breadcrumb path can be walked backward from
 * `matchIndex`. Returns the number of crumbs successfully matched (used as a
 * tie-break score among multiple target candidates), or 0 if any crumb
 * fails. Reverse traversal: deepest crumb is the closest header above the
 * match.
 */
function verifyContext(lines: string[], fencedMask: boolean[], matchIndex: number, context: string): number {
    const crumbs = context.split('>').map(c => c.trim()).reverse();
    let currentIdx = matchIndex;
    let matchedCount = 0;

    for (const rawCrumb of crumbs) {
        const crumb = parseCrumb(rawCrumb);
        let found = false;

        for (let i = currentIdx - 1; i >= 0; i--) {
            if (matchCrumb(lines[i], fencedMask[i], crumb)) {
                found = true;
                matchedCount++;
                currentIdx = i;
                break;
            }
        }

        if (!found) return 0;
    }

    return matchedCount;
}

export function findMatchRange(content: string, target: string, context?: string): { start: number; end: number } | null {
    const normalizedContent = normalizeForComparison(content);
    const normalizedTarget = normalizeForComparison(target);

    if (!normalizedTarget) return null;

    let searchStart = 0;
    const candidates: { start: number; end: number; score: number }[] = [];

    const lines = context ? content.split(/\r?\n/) : null;
    const fencedMask = lines ? computeFencedLineMask(lines) : null;
    // Both per-iteration calls (start, lastChar) and the next iteration's
    // searchStart=normalizedIndex+1 advance forward, so the mapper's
    // monotonic-input contract holds.
    const mapToOriginal = createIndexMapper(content);

    while (true) {
        const normalizedIndex = normalizedContent.indexOf(normalizedTarget, searchStart);
        if (normalizedIndex === -1) break;

        let start = mapToOriginal(normalizedIndex);
        const lastCharIndex = mapToOriginal(normalizedIndex + normalizedTarget.length - 1);
        let end = lastCharIndex + 1;

        // If target has leading/trailing horizontal whitespace, swallow the
        // matching whitespace in the original so replacements stay
        // predictable (no orphan spaces left behind).
        const leadingSpaceMatch = target.match(/^([ \t]+)/);
        if (leadingSpaceMatch) {
            const spaces = leadingSpaceMatch[1];
            if (content.substring(Math.max(0, start - spaces.length), start) === spaces) {
                start -= spaces.length;
            }
        }

        const trailingSpaceMatch = target.match(/([ \t]+)$/);
        if (trailingSpaceMatch) {
            const spaces = trailingSpaceMatch[1];
            if (content.substring(end, end + spaces.length) === spaces) {
                end += spaces.length;
            }
        }

        if (context && lines && fencedMask) {
            const lineIndex = getLineIndexFromCharIndex(content, start);
            const score = verifyContext(lines, fencedMask, lineIndex, context);
            if (score > 0) {
                candidates.push({ ...expandRange(content, target, start, end), score });
            }
        } else {
            candidates.push({ ...expandRange(content, target, start, end), score: 1 });
        }

        searchStart = normalizedIndex + 1;
    }

    if (candidates.length === 0) return null;

    // Highest context score wins; ties keep first occurrence (stable sort).
    return candidates.sort((a, b) => b.score - a.score)[0];
}

/**
 * Walk forward through breadcrumb crumbs, then return the first line index
 * past the matched section's end (next header of ≤ same level). Returns -1
 * if `context` is given but no crumb matched anywhere — caller must NOT fall
 * back to EOF in that case (would silently insert at the wrong place).
 */
export function findInsertionPoint(lines: string[], context?: string): number {
    if (!context) return lines.length;

    // Skip fenced lines entirely — a `## fake` inside ```...``` must not be
    // matchable as the insertion anchor. Sibling walkers (verifyContext,
    // findContextLine) only fence-gate heading detection but still allow
    // loose body-text `includes` matching; this walker is stricter to
    // protect insertion sites from injection via fenced content.
    const fencedMask = computeFencedLineMask(lines);

    const crumbs = context.split('>').map(c => c.trim());
    let currentLine = 0;
    let anyFound = false;

    for (const rawCrumb of crumbs) {
        const crumb = parseCrumb(rawCrumb);
        let found = -1;

        for (let i = currentLine; i < lines.length; i++) {
            if (fencedMask[i]) continue;
            if (matchCrumb(lines[i], false, crumb)) {
                found = i;
                anyFound = true;
                break;
            }
        }

        if (found !== -1) {
            currentLine = found + 1;
        }
        // Skipped-layer tolerance: if a crumb misses, keep scanning the next
        // crumb from the SAME currentLine (don't reset, don't fail).
    }

    if (!anyFound) return -1;

    // Find end of current section: next header of ≤ landed level.
    // Uses lenient `^(#+)` count rather than `parseAtxHeading` so a crumb
    // that landed on `####### foo` (rejected by strict ATX parse) still
    // reports a level instead of degenerating to 0.
    const headerLine = lines[currentLine - 1].trimStart();
    const headerLevelMatch = headerLine.match(/^(#+)/);

    // If the final landing line isn't a header at all (loose body-text
    // match), insert immediately AFTER the anchor. Falling through to a
    // boundary scan with currentLevel=0 would silently dump content at EOF.
    if (!headerLevelMatch) return currentLine;

    const currentLevel = headerLevelMatch[1].length;
    for (let i = currentLine; i < lines.length; i++) {
        if (fencedMask[i]) continue;
        const nextHeaderMatch = lines[i].trimStart().match(/^(#+)/);
        if (nextHeaderMatch && nextHeaderMatch[1].length <= currentLevel) {
            return i;
        }
    }

    return lines.length;
}

/**
 * Walk forward through crumbs and return the line index of the LAST one
 * found, for navigating to a section header even when content match fails.
 */
export function findContextLine(content: string, context: string): number | null {
    if (!context) return null;
    const lines = content.split(/\r?\n/);
    const fencedMask = computeFencedLineMask(lines);
    const crumbs = context.split('>').map(c => c.trim());
    let currentLine = 0;
    let lastFoundLine: number | null = null;

    for (const rawCrumb of crumbs) {
        const crumb = parseCrumb(rawCrumb);
        let found = -1;

        for (let i = currentLine; i < lines.length; i++) {
            if (matchCrumb(lines[i], fencedMask[i], crumb)) {
                found = i;
                break;
            }
        }

        if (found !== -1) {
            lastFoundLine = found;
            currentLine = found + 1;
        }
    }

    return lastFoundLine;
}

/**
 * Walk backward from a line and assemble the heading breadcrumb chain
 * (e.g. `# Top > ## Sub`). Stops at the first H1 (full path captured).
 */
export function inferContextFromLine(content: string, lineIndex: number): string {
    const lines = content.split(/\r?\n/);
    const fencedMask = computeFencedLineMask(lines);
    const crumbs: string[] = [];
    let currentLevel = Infinity;

    const start = Math.min(lineIndex, lines.length - 1);

    for (let i = start; i >= 0; i--) {
        if (fencedMask[i]) continue;
        const heading = parseAtxHeading(lines[i]);
        if (heading && heading.level < currentLevel) {
            crumbs.unshift(lines[i].trim());
            currentLevel = heading.level;
            if (heading.level === 1) break;
        }
    }

    return crumbs.join(' > ');
}
