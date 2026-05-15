import { MarkdownHeader } from '@app/features/sidebar/file-viewer-dialog.component';
import { findAtxHeadings } from '@app/core/utils/markdown.util';

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

export function parseMarkdownOutline(fileName: string, content: string): MarkdownHeader[] {
  if (!fileName || !fileName.endsWith('.md') || !content) return [];
  const lines = content.split('\n');
  return findAtxHeadings(lines).map(h => ({
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
  const headings = findAtxHeadings(lines);
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
  // `''.split('\n')` is `['']`, not `[]` — treat that single empty token as an empty
  // file so we don't emit a junk separator newline before/after the inserted heading.
  const isEmpty = lines.length === 1 && lines[0] === '';

  if (!anchor) {
    // Append to end of file
    if (isEmpty) {
      return { newContent: insertLines.join('\n'), insertedAtLine: 1 };
    }
    const trailing = lines[lines.length - 1] === '' ? [] : [''];
    const newLines = [...lines, ...trailing, ...insertLines];
    return { newContent: newLines.join('\n'), insertedAtLine: lines.length + trailing.length + 1 };
  }

  if (anchor === 'prepend') {
    if (isEmpty) {
      return { newContent: insertLines.join('\n'), insertedAtLine: 1 };
    }
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
  return findAtxHeadings(lines)
    .filter(h => h.index > bounds.startLine && h.index <= bounds.endLine && h.level > bounds.level)
    .map(h => lines[h.index].trim());
}

/** Returns true if the section contains any child headers (level > section.level). */
export function sectionHasChildren(content: string, bounds: SectionBounds): boolean {
  return getDescendantHeaders(content, bounds).length > 0;
}

export interface AmbiguousSectionError {
  error: string;
  matches: { startLine: number, headerText: string }[];
}

export function ambiguousSectionError(
  op: 'read' | 'replace',
  pathStr: string,
  matches: { startLine: number, headerText: string }[]
): AmbiguousSectionError {
  return {
    error: `Ambiguous sectionPath "${pathStr}" — ${matches.length} sections match. Refusing to ${op} silently. Use a more specific sectionPath (include parent headings) or fall back to readFile + replaceFile if the headings are truly identical.`,
    matches: matches.map(m => ({ startLine: m.startLine + 1, headerText: m.headerText.trim() }))
  };
}
