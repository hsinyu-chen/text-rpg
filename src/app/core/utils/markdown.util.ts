/**
 * Mark every line that lies inside (or is the delimiter of) a fenced code
 * block (``` / ~~~) so heading-style scans can skip them. Without this, a
 * `# foo` line inside a code fence is mis-treated as an ATX heading,
 * which corrupts outlines, section bounds, and breadcrumb inference.
 *
 * Fence rules per CommonMark: opening up to 3 spaces indent + 3+ same fence
 * chars (info string after is allowed); closing must use the same char and
 * >= the opening length, with trailing whitespace only (no info string).
 * An unclosed fence runs to end-of-document.
 */
export function computeFencedLineMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceChar) {
      mask[i] = true;
      const close = line.match(/^(\s{0,3})(([`~])\3{2,})\s*$/);
      if (close && close[3] === fenceChar && close[2].length >= fenceLen) {
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }
    const open = line.match(/^(\s{0,3})(([`~])\3{2,})/);
    if (open) {
      const char = open[3];
      // Backtick fence info strings cannot contain backticks per CommonMark — if they do,
      // the line isn't a valid fence opener and we must not enter fence state (otherwise
      // every subsequent heading would be incorrectly masked through end-of-document).
      if (char === '`' && line.slice(open[0].length).includes('`')) continue;
      mask[i] = true;
      fenceChar = char;
      fenceLen = open[2].length;
    }
  }
  return mask;
}

/**
 * Canonical ATX heading regex — single source of truth for heading detection
 * across file-agent (outline / section bounds) and file-update (breadcrumb
 * inference / context verification). Previously these sites carried two
 * divergent regexes (`^(#{1,6})\s+(.+)$` vs `^(#+)\s*(.*)`) that disagreed on
 * empty body, 7+ hashes, no-space-after-hash, and indent — meaning the same
 * `.md` file could produce inconsistent outline entries vs breadcrumbs.
 *
 * CommonMark §4.2 with ONE deliberate deviation: leading indent is
 * unrestricted. The spec caps indent at 3 spaces (4+ is indented code), but
 * `file-update.service.ts` has historically tolerated arbitrary indent via
 * `.trim()`, and user-authored markdown sometimes nests headings deep inside
 * list items. Dropping those silently is a worse failure mode than the
 * spec-purist alternative.
 *
 * The regex itself only captures level + raw body; the optional closing `#+`
 * sequence is stripped in `parseAtxHeading` rather than in the regex,
 * because expressing "closing seq must be space-preceded EXCEPT when body
 * is empty (`### ###`)" inline produces a regex that fails one of those two
 * cases. Post-processing handles both.
 *
 * `[ \t]` instead of `\s` so a stray `\r` from CRLF input doesn't get
 * absorbed into the indent class on lines that haven't been trimEnd'd.
 */
const ATX_HEADING_RE = /^[ \t]*(#{1,6})(?:[ \t]+(.*))?$/;

/**
 * Strip a CommonMark ATX closing sequence (` ###...` / leading `#+` when
 * body is bare hashes). The sequence must be either at start (empty-body
 * case `### ###`) or whitespace-preceded — `### Foo#` keeps its trailing
 * `#` because there's no space before it.
 */
const ATX_CLOSING_SEQ_RE = /(?:^|[ \t]+)#+$/;

export interface AtxHeading {
  /** Heading level, 1–6. */
  level: number;
  /** Body text, trimmed. Empty string for bare `###` or `### ###` (templates rely on this). */
  text: string;
}

/**
 * Parse a single line as an ATX heading. Caller is responsible for
 * fence-skipping — combine with `computeFencedLineMask` when scanning whole
 * files, or use `findAtxHeadings` which already does both.
 */
export function parseAtxHeading(line: string): AtxHeading | null {
  const m = line.trimEnd().match(ATX_HEADING_RE);
  if (!m) return null;
  const raw = (m[2] ?? '').trimEnd();
  const text = raw.replace(ATX_CLOSING_SEQ_RE, '').trim();
  return { level: m[1].length, text };
}

export interface AtxHeadingHit extends AtxHeading {
  /** 0-based line index in the source array. */
  index: number;
}

/** Scan all lines for ATX headings, skipping fenced code blocks. */
export function findAtxHeadings(lines: string[]): AtxHeadingHit[] {
  const fencedMask = computeFencedLineMask(lines);
  const out: AtxHeadingHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (fencedMask[i]) continue;
    const h = parseAtxHeading(lines[i]);
    if (h) out.push({ ...h, index: i });
  }
  return out;
}
