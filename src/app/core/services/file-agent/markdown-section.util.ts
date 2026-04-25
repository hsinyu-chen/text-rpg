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

export function parseMarkdownOutline(fileName: string, content: string): MarkdownHeader[] {
  if (!fileName || !fileName.endsWith('.md') || !content) return [];

  const headers: MarkdownHeader[] = [];
  const lines = content.split('\n');
  lines.forEach((line, index) => {
    const match = line.trimEnd().match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headers.push({
        level: match[1].length,
        text: match[2].trim(),
        lineNumber: index + 1
      });
    }
  });
  return headers;
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
  const currentStack: { level: number, text: string }[] = [];
  const matches: { startLine: number, level: number, headerText: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
    if (!m) continue;
    const level = m[1].length;
    const text = m[2].trim();

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
      if (isMatch) {
        matches.push({ startLine: i, level, headerText: lines[i] });
      }
    }
  }

  return matches.map(match => {
    let endLine = lines.length - 1;
    for (let i = match.startLine + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s+(.+)$/);
      if (m && m[1].length <= match.level) {
        endLine = i - 1;
        break;
      }
    }
    return { startLine: match.startLine, endLine, level: match.level, headerText: match.headerText };
  });
}

export function resolveSection(content: string, pathStr: string): SectionResolution {
  const matches = findMarkdownSections(content, pathStr);
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'ok', section: matches[0] };
  return { kind: 'ambiguous', matches };
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
