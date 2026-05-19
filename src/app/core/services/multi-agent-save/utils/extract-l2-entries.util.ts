import { findAtxHeadings } from '@app/core/utils/markdown.util';

/**
 * Structurally-equivalent shape of {@link import('../multi-agent-save.types').CharacterEntry}
 * and {@link import('../multi-agent-save.types').FactionEntry}. The two
 * interfaces stay separate at the domain level (so consumers can later
 * specialize), but the extraction logic is identical and lives here.
 */
export interface L2Entry {
  name: string;
  headingPath: string;
  group: string;
  startLine: number;
  endLine: number;
  rawText: string;
}

export interface ExtractL2EntriesOptions {
  /** Predicate evaluated on the L2 heading text — return `true` to skip. */
  exclude?: (name: string) => boolean;
}

/**
 * Walk the heading list once and emit every L2 heading that lives under
 * some L1 ancestor as an entry. Bounds are derived inline by scanning
 * forward to the next heading of level ≤ 2; trailing blank lines are
 * trimmed so they read as inter-entry separators (parity with
 * {@link import('@app/core/services/file-agent/markdown-section.util').findMarkdownSections}).
 *
 * **Why not delegate to `findMarkdownSections`?** Calling it per-entry
 * is O(N²) — full file re-parse for every L2 — and a more subtle bug:
 * when two L2s share the same name under the same L1, the function takes
 * `matches[0]` so both entries get the bounds of the first occurrence,
 * silently producing duplicated content. Walking the heading list once
 * here is both cheaper and correct.
 *
 * Orphan L2s (no L1 ancestor) are dropped — that's a structural sanity
 * guard, not a domain filter; a heading with no parent has no breadcrumb
 * to attach to `<save context="…">`.
 */
export function extractL2EntriesByGroup(
  content: string,
  options: ExtractL2EntriesOptions = {}
): L2Entry[] {
  const lines = content.split('\n');
  const headings = findAtxHeadings(lines);
  const entries: L2Entry[] = [];

  let currentL1 = '';
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];

    if (h.level === 1) {
      currentL1 = h.text;
      continue;
    }
    if (h.level !== 2) continue;
    if (!currentL1) continue;
    if (options.exclude?.(h.text)) continue;

    const startLine = h.index;
    let endLine = lines.length - 1;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= 2) {
        endLine = headings[j].index - 1;
        break;
      }
    }
    while (endLine > startLine && lines[endLine].trim() === '') {
      endLine--;
    }

    entries.push({
      name: h.text,
      headingPath: `# ${currentL1} > ## ${h.text}`,
      group: currentL1,
      startLine,
      endLine,
      rawText: lines.slice(startLine, endLine + 1).join('\n'),
    });
  }

  return entries;
}
