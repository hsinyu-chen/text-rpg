import { MarkdownHeader } from '../../../features/sidebar/file-viewer-dialog.component';

export interface SectionBounds {
  startLine: number;
  endLine: number;
  level: number;
  headerText: string;
}

export type SectionResolution =
  | { kind: 'ok', section: SectionBounds }
  | { kind: 'none' }
  | { kind: 'ambiguous', matches: SectionBounds[] };

interface HeadingHit {
  index: number;
  level: number;
  text: string;
}

/**
 * Scan markdown lines for ATX headings, FSM-skipping fenced code blocks
 * so `# foo` lines inside ``` / ~~~ fences don't get mistaken for headings.
 * Closing fence requires same char and >= length per CommonMark.
 */
function findHeadingLines(lines: string[]): HeadingHit[] {
  const out: HeadingHit[] = [];
  let fenceChar = '';
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceChar) {
      const close = line.match(/^(\s{0,3})([`~]{3,})\s*$/);
      if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
        fenceChar = '';
        fenceLen = 0;
      }
      continue;
    }
    const open = line.match(/^(\s{0,3})([`~]{3,})/);
    if (open) {
      fenceChar = open[2][0];
      fenceLen = open[2].length;
      continue;
    }
    const hm = line.trimEnd().match(/^(#{1,6})\s+(.+)$/);
    if (hm) out.push({ index: i, level: hm[1].length, text: hm[2].trim() });
  }
  return out;
}

export function parseMarkdownOutline(fileName: string, content: string): MarkdownHeader[] {
  if (!fileName || !fileName.endsWith('.md') || !content) return [];
  const lines = content.split('\n');
  return findHeadingLines(lines).map(h => ({
    level: h.level,
    text: h.text,
    lineNumber: h.index + 1
  }));
}

/**
 * Find every markdown section whose heading stack ends with `pathStr`.
 * Returning all matches (instead of bailing on the first) lets readSection
 * and replaceSection detect ambiguous paths and refuse to silently edit
 * the wrong one. Bounds are computed for every match by treating the next
 * heading-of-equal-or-lower level as the section terminator.
 */
export function findMarkdownSections(content: string, pathStr: string): SectionBounds[] {
  if (!pathStr) return [];
  const path = pathStr.split('>').map(s => s.trim().replace(/^#+\s*/, ''));
  if (path.length === 0) return [];

  const lines = content.split('\n');
  const headings = findHeadingLines(lines);
  const currentStack: { level: number, text: string }[] = [];
  const matchedIdx: number[] = [];

  for (let h = 0; h < headings.length; h++) {
    const { level, text } = headings[h];
    while (currentStack.length > 0 && currentStack[currentStack.length - 1].level >= level) {
      currentStack.pop();
    }
    currentStack.push({ level, text });

    if (currentStack.length >= path.length) {
      let isMatch = true;
      for (let p = 0; p < path.length; p++) {
        if (currentStack[currentStack.length - path.length + p].text !== path[p]) {
          isMatch = false;
          break;
        }
      }
      if (isMatch) matchedIdx.push(h);
    }
  }

  return matchedIdx.map(idx => {
    const match = headings[idx];
    let endLine = lines.length - 1;
    for (let j = idx + 1; j < headings.length; j++) {
      if (headings[j].level <= match.level) {
        endLine = headings[j].index - 1;
        break;
      }
    }
    // Exclude trailing blank lines so they stay as separators between sections
    while (endLine > match.index && lines[endLine].trim() === '') {
      endLine--;
    }
    return { startLine: match.index, endLine, level: match.level, headerText: lines[match.index] };
  });
}

export function resolveSection(content: string, pathStr: string): SectionResolution {
  const matches = findMarkdownSections(content, pathStr);
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'ok', section: matches[0] };
  return { kind: 'ambiguous', matches };
}

export function insertSectionIntoContent(
  content: string,
  heading: string,
  body: string | undefined,
  anchor: 'prepend' | 'before' | 'after' | 'append-into' | undefined,
  anchorSectionPath: string | undefined
): { newContent: string; insertedAtLine: number } | { error: string } {
  const lines = content.split('\n');
  const insertLines = [heading, ...(body ? body.split('\n') : [])];

  if (!anchor) {
    // Append to end of file
    const trailing = lines[lines.length - 1] === '' ? [] : [''];
    const newLines = [...lines, ...trailing, ...insertLines];
    return { newContent: newLines.join('\n'), insertedAtLine: lines.length + trailing.length + 1 };
  }

  if (anchor === 'prepend') {
    const newLines = [...insertLines, '', ...lines];
    return { newContent: newLines.join('\n'), insertedAtLine: 1 };
  }

  if (!anchorSectionPath) {
    return { error: `anchor "${anchor}" requires anchorSectionPath` };
  }

  const resolution = resolveSection(content, anchorSectionPath);
  if (resolution.kind === 'none') return { error: `Anchor section "${anchorSectionPath}" not found` };
  if (resolution.kind === 'ambiguous') {
    return { error: `Anchor section "${anchorSectionPath}" is ambiguous (${resolution.matches.length} matches). Use a more specific path.` };
  }

  const bounds = resolution.section;

  if (anchor === 'before') {
    const prefix = lines.slice(0, bounds.startLine);
    const suffix = lines.slice(bounds.startLine);
    const newLines = [...prefix, ...insertLines, '', ...suffix];
    return { newContent: newLines.join('\n'), insertedAtLine: bounds.startLine + 1 };
  }

  // 'after' and 'append-into' both insert after the section's last line
  const prefix = lines.slice(0, bounds.endLine + 1);
  const suffix = lines.slice(bounds.endLine + 1);
  const newLines = [...prefix, '', ...insertLines, ...suffix];
  return { newContent: newLines.join('\n'), insertedAtLine: bounds.endLine + 3 };
}

/** Returns all descendant header lines within the section (any level deeper than section.level). */
export function getDescendantHeaders(content: string, bounds: SectionBounds): string[] {
  const lines = content.split('\n');
  return findHeadingLines(lines)
    .filter(h => h.index > bounds.startLine && h.index <= bounds.endLine && h.level > bounds.level)
    .map(h => lines[h.index].trim());
}

/** Returns true if the section contains any child headers (level > section.level). */
export function sectionHasChildren(content: string, bounds: SectionBounds): boolean {
  return getDescendantHeaders(content, bounds).length > 0;
}

export function ambiguousSectionError(
  op: 'read' | 'replace',
  pathStr: string,
  matches: { startLine: number, headerText: string }[]
): Record<string, unknown> {
  return {
    error: `Ambiguous sectionPath "${pathStr}" — ${matches.length} sections match. Refusing to ${op} silently. Use a more specific sectionPath (include parent headings) or fall back to readFile + replaceFile if the headings are truly identical.`,
    matches: matches.map(m => ({ startLine: m.startLine + 1, headerText: m.headerText.trim() }))
  };
}
