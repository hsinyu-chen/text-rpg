import { computeFencedLineMask, parseAtxHeading } from '../utils/markdown.util';

/**
 * Markdown range/anchor matcher tuned for LLM-generated update hunks.
 *
 * Distinct from `markdown-section.util.ts` (which file-agent uses): that one
 * is strict equality + ambiguous-refuse for tool-driven edits; this one is
 * loose `includes` matching because the LLM's `target` is approximate. The
 * `context` breadcrumb is a `string[]` of raw heading texts (outermost →
 * innermost) — no `#` prefix, no `>` separator, no level encoding.
 */

/**
 * Score a line's match against a crumb. Higher = more specific.
 * Tier scores: 30 = exact equality (normalized), 20 = prefix, 10 =
 * substring. Headings get a +1 bonus so an ATX heading wins over a
 * paragraph at the same tier (the LLM is supposed to anchor on headings;
 * body match is a fallback for list-item / paragraph cases). 0 = no
 * match, empty crumb, or fenced line.
 *
 * Tiered so callers can prefer an exact heading match over a paragraph
 * that happens to mention the heading name. The substring tier is
 * retained so `Section` still matches `# Section (note)` (the
 * parenthetical-suffix tolerance that motivates this matcher) — but
 * only when no exact / prefix match exists in scope.
 */
function matchCrumb(line: string, fenced: boolean, crumb: string): number {
    if (fenced) return 0;
    const lineHeading = parseAtxHeading(line);
    const lineText = lineHeading ? lineHeading.text : line.trim();
    const normalizedLine = normalizeForComparison(lineText);
    const normalizedCrumb = normalizeForComparison(crumb);
    if (!normalizedCrumb) return 0;

    let score = 0;
    if (normalizedLine === normalizedCrumb) score = 30;
    else if (normalizedLine.startsWith(normalizedCrumb)) score = 20;
    else if (normalizedLine.includes(normalizedCrumb)) score = 10;

    if (score > 0 && lineHeading) score += 1;
    return score;
}

const MAX_CRUMB_SCORE = 31;

/**
 * Scan a slice of `lines` for the highest-scoring crumb match.
 * `step` direction-aware: 1 walks forward `[start, end)`, -1 walks
 * backward `(end, start]`. Exact matches short-circuit further scanning.
 * Returns `{ line: -1, score: 0 }` when nothing in scope matches.
 */
function pickBestCrumbMatch(
    lines: string[],
    fencedMask: boolean[],
    crumb: string,
    start: number,
    end: number,
    step: 1 | -1,
): { line: number; score: number } {
    let bestLine = -1;
    let bestScore = 0;
    for (let i = start; step > 0 ? i < end : i > end; i += step) {
        const score = matchCrumb(lines[i], fencedMask[i], crumb);
        if (score > bestScore) {
            bestScore = score;
            bestLine = i;
            if (score === MAX_CRUMB_SCORE) break;
        }
    }
    return { line: bestLine, score: bestScore };
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
 * `matchIndex`. Returns the sum of crumb match scores (used as a tie-break
 * among multiple target candidates) — higher = more specific match — or 0
 * if any crumb fails. Reverse traversal: deepest crumb is the closest
 * ancestor above the match. Within each crumb's backward window the
 * highest-scoring line wins, so an exact heading match further back beats
 * a substring mention that's closer (which would typically be body text).
 */
function verifyContext(lines: string[], fencedMask: boolean[], matchIndex: number, context: string[]): number {
    const crumbs = [...context].reverse();
    let currentIdx = matchIndex;
    let totalScore = 0;

    for (const crumb of crumbs) {
        const { line, score } = pickBestCrumbMatch(lines, fencedMask, crumb, currentIdx - 1, -1, -1);
        if (line === -1) return 0;
        totalScore += score;
        currentIdx = line;
    }

    return totalScore;
}

export function findMatchRange(content: string, target: string, context?: string[]): { start: number; end: number } | null {
    const normalizedContent = normalizeForComparison(content);
    const normalizedTarget = normalizeForComparison(target);

    if (!normalizedTarget) return null;

    let searchStart = 0;
    const candidates: { start: number; end: number; score: number }[] = [];

    const crumbs = context?.filter(c => c) ?? [];
    const hasContext = crumbs.length > 0;
    const lines = hasContext ? content.split(/\r?\n/) : null;
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

        if (hasContext && lines && fencedMask) {
            const lineIndex = getLineIndexFromCharIndex(content, start);
            const score = verifyContext(lines, fencedMask, lineIndex, crumbs);
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
export function findInsertionPoint(lines: string[], context?: string[]): number {
    const crumbs = context?.filter(c => c) ?? [];
    if (crumbs.length === 0) return lines.length;

    const fencedMask = computeFencedLineMask(lines);

    let currentLine = 0;
    let anyFound = false;

    for (const crumb of crumbs) {
        const { line } = pickBestCrumbMatch(lines, fencedMask, crumb, currentLine, lines.length, 1);
        if (line !== -1) {
            currentLine = line + 1;
            anyFound = true;
        }
        // Skipped-layer tolerance: if a crumb misses, keep scanning the next
        // crumb from the SAME currentLine (don't reset, don't fail).
    }

    if (!anyFound) return -1;

    // When the leaf crumb landed on a body line (list-item / paragraph), there
    // is no section to compute a boundary for — insert immediately AFTER the
    // anchor rather than scanning to EOF. When it landed on a header, find the
    // next header of ≤ landed level.
    const landed = parseAtxHeading(lines[currentLine - 1]);
    if (!landed) return currentLine;
    const currentLevel = landed.level;

    for (let i = currentLine; i < lines.length; i++) {
        if (fencedMask[i]) continue;
        const nextHeader = parseAtxHeading(lines[i]);
        if (nextHeader && nextHeader.level <= currentLevel) {
            return i;
        }
    }

    return lines.length;
}

/**
 * Walk forward through crumbs and return the line index of the LAST one
 * found, for navigating to a section header even when content match fails.
 */
export function findContextLine(content: string, context: string[]): number | null {
    const crumbs = context?.filter(c => c) ?? [];
    if (crumbs.length === 0) return null;
    const lines = content.split(/\r?\n/);
    const fencedMask = computeFencedLineMask(lines);
    let currentLine = 0;
    let lastFoundLine: number | null = null;

    for (const crumb of crumbs) {
        const { line } = pickBestCrumbMatch(lines, fencedMask, crumb, currentLine, lines.length, 1);
        if (line !== -1) {
            lastFoundLine = line;
            currentLine = line + 1;
        }
    }

    return lastFoundLine;
}

/**
 * Walk backward from a line and assemble the heading breadcrumb chain
 * as raw heading-text crumbs (`["Top", "Sub"]`). Stops at the first H1.
 */
export function inferContextFromLine(content: string, lineIndex: number): string[] {
    const lines = content.split(/\r?\n/);
    const fencedMask = computeFencedLineMask(lines);
    const crumbs: string[] = [];
    let currentLevel = Infinity;

    const start = Math.min(lineIndex, lines.length - 1);

    for (let i = start; i >= 0; i--) {
        if (fencedMask[i]) continue;
        const heading = parseAtxHeading(lines[i]);
        if (heading && heading.level < currentLevel) {
            crumbs.unshift(heading.text);
            currentLevel = heading.level;
            if (heading.level === 1) break;
        }
    }

    return crumbs;
}
