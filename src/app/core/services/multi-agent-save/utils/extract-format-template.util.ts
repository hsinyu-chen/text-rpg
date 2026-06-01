import { findAtxHeadings } from '@app/core/utils/markdown.util';

/**
 * Pulls the KB file's format-definition section so a per-entity state agent
 * can show the LLM "this is what an entry should look like" before it writes
 * a revise / new hunk — keeping authored entries on the user's own schema.
 *
 * The section is identified by its heading text containing 「格式」 or
 * `format` (case-insensitive), at L1 or L2. The providers blacklist that
 * section out of the entity roster (`excluded-entry-names.util`), so it has
 * to be re-extracted here rather than read off an entry.
 *
 * Returns the full section text (heading line through its last non-blank
 * body line, trailing blanks trimmed) for the FIRST matching heading, or an
 * empty string when the file has no such section — not every KB defines one,
 * so absence is normal, not an error.
 */
export function extractFormatTemplate(content: string): string {
    const lines = content.split('\n');
    const headings = findAtxHeadings(lines);

    for (let i = 0; i < headings.length; i++) {
        const h = headings[i];
        if (!isFormatHeading(h.text)) continue;

        const startLine = h.index;
        let endLine = lines.length - 1;
        // Section ends at the next heading of the same or shallower level.
        for (let j = i + 1; j < headings.length; j++) {
            if (headings[j].level <= h.level) {
                endLine = headings[j].index - 1;
                break;
            }
        }
        while (endLine > startLine && lines[endLine].trim() === '') endLine--;
        return lines.slice(startLine, endLine + 1).join('\n');
    }

    return '';
}

/** True when a heading announces a format / 格式 definition section. */
function isFormatHeading(text: string): boolean {
    return text.includes('格式') || /format/i.test(text);
}
