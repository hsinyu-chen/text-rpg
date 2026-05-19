import { LLMFunctionDeclaration } from '@hcs/llm-core';
import { REASON_DESC } from './tool-helpers';

/**
 * Write tools that mutate KB markdown files. Agent surfaces that should NOT
 * write (chat-panel main agent without editor open, save-sim per-entity
 * agent) must gate at dispatch (e.g. `context.readOnly = true`) — these
 * declarations should not appear in their tool catalog at all.
 */

export const REPLACE_FILE_TOOL: LLMFunctionDeclaration = {
    name: 'replaceFile',
    description: 'Replace the entire content of a file',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            filename: { type: 'string', description: 'The exact path of the file' },
            content: { type: 'string', description: 'The new full content of the file' },
        },
        required: ['reason', 'filename', 'content'],
    },
};

export const SEARCH_REPLACE_TOOL: LLMFunctionDeclaration = {
    name: 'searchReplace',
    description: 'Apply one or more pattern-based replacements to a file in one shot WITHOUT transferring the file body through context. For a single edit, pass a one-element replacements array. For multiple mechanical edits in the same file, pass them all in one call. Returns total replacement count and per-pattern details. Workflow: grep first to confirm match counts, then call with expectedTotalReplacements set to the sum (or set per-entry expectedCount) as a safety net. For non-trivial regex, run with dryRun=true first to preview before/after samples.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            filename: { type: 'string', description: 'The exact path of the file' },
            replacements: {
                type: 'array',
                description: 'One or more replacements to apply in sequence. Each entry: {pattern, replacement, isRegex?, caseInsensitive?, multiline?, expectedCount?}.',
                items: {
                    type: 'object',
                    properties: {
                        pattern: { type: 'string', description: 'The string or regex to find. With isRegex=false (default) this is matched literally. With isRegex=true this is a JavaScript regex source — no surrounding slashes, no inline flags.' },
                        replacement: { type: 'string', description: 'The string to replace each match with. Pass "" to delete matches. With isRegex=true, $1/$2/$& backreferences are honored.' },
                        isRegex: { type: 'boolean', description: 'Optional. Default false. Set true to treat pattern as a JavaScript regex.' },
                        caseInsensitive: { type: 'boolean', description: 'Optional. Default false. Adds the i flag.' },
                        multiline: { type: 'boolean', description: 'Optional. Default false. Adds the m flag (^ and $ match line boundaries). Only meaningful with isRegex=true.' },
                        expectedCount: { type: 'number', description: 'Optional safety net. If provided and the actual count for THIS pattern differs, the entire call fails and the file is unchanged.' },
                    },
                    required: ['pattern', 'replacement'],
                },
            },
            expectedTotalReplacements: { type: 'number', description: 'Optional safety net summing replacement counts across all entries IN THIS CALL. Each searchReplace call writes to exactly ONE file, so this is a PER-FILE expected total — never a cross-file sum. When renaming across multiple files, stratify your grep results by filename first and pass the per-file count to each call. If the actual per-file total differs from this number, the entire call fails and THE FILE IS NOT CHANGED (the error response will say "File unchanged"); do not narrate success in that case.' },
            dryRun: { type: 'boolean', description: 'Optional. Default false. If true, no write happens — returns counts and up to 3 before/after samples per pattern.' },
        },
        required: ['reason', 'filename', 'replacements'],
    },
};

export const REPLACE_SECTION_TOOL: LLMFunctionDeclaration = {
    name: 'replaceSection',
    description: 'Replace the body of one or more markdown sections. Pass a single section as a one-element updates array. **IMPORTANT: Each entry fails if its section has child subsections — the error lists every child that would be deleted.** Per-entry force: true allows the deletion only when intentional. Otherwise, target each child by its full path (e.g. "Parent>Child") or use insertSection.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            filename: { type: 'string', description: 'The exact path of the file' },
            updates: {
                type: 'array',
                description: 'One or more section updates applied atomically (bottom-to-top so earlier paths remain valid).',
                items: {
                    type: 'object',
                    properties: {
                        sectionPath: { type: 'string', description: 'Path of headers separated by ">", e.g. "Character>Stats>Health"' },
                        content: { type: 'string', description: 'The new body content for this section (without the heading line). Pass "" to clear the body.' },
                        newTitle: { type: 'string', description: 'Optional. If provided, renames the section header.' },
                        force: { type: 'boolean', description: 'Optional. Default false. Set true to allow replacing this entry even if it has child subsections, permanently deleting them.' },
                    },
                    required: ['sectionPath', 'content'],
                },
            },
        },
        required: ['reason', 'filename', 'updates'],
    },
};

export const INSERT_SECTION_TOOL: LLMFunctionDeclaration = {
    name: 'insertSection',
    description: 'Insert a NEW markdown section (with its own heading) at a specific position. heading must include the hash marks (e.g. "## New Section"). content is the section body ONLY — DO NOT repeat the heading line inside content (the runtime writes the heading from the "heading" arg, then content directly below it; duplicating the heading produces two identical headings in the file). anchor controls where to insert: "prepend" = before everything in the file; "before" = immediately before anchorSectionPath (sibling); "after" = immediately after anchorSectionPath and all its content (sibling); "append-into" = as the last child inside anchorSectionPath. Omit anchor entirely to append at end of file. To insert plain lines (without a heading) into an existing section, use insertIntoSection instead.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            filename: { type: 'string', description: 'The exact path of the file' },
            heading: { type: 'string', description: 'Full heading line including hashes, e.g. "## Equipment"' },
            content: { type: 'string', description: 'Section body content WITHOUT the heading line (optional). Do NOT repeat the value of "heading" here — the runtime emits the heading on its own line and then this content; including the heading again creates a duplicate.' },
            anchor: { type: 'string', enum: ['prepend', 'before', 'after', 'append-into'], description: 'Where to insert. Omit to append at end of file.' },
            anchorSectionPath: { type: 'string', description: 'Required for before/after/append-into. Path like "Character>Stats"' },
        },
        required: ['reason', 'filename', 'heading'],
    },
};

export const INSERT_INTO_SECTION_TOOL: LLMFunctionDeclaration = {
    name: 'insertIntoSection',
    description: 'Insert plain text lines into an existing markdown section, WITHOUT introducing a new heading. Use this to append/prepend body content (paragraphs, list items, table rows) to a section. position="start" inserts right after the heading line (top of the body, before any child sections); position="end" inserts at the very end of the section (after all children, before the next sibling). For inserting a NEW subheading, use insertSection instead.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            filename: { type: 'string', description: 'The exact path of the file' },
            sectionPath: { type: 'string', description: 'Path of headers separated by ">", e.g. "Character>Stats"' },
            content: { type: 'string', description: 'The lines to insert. Multi-line is supported. Will not include any heading line — pass body content only.' },
            position: { type: 'string', enum: ['start', 'end'], description: '"start" = right after the heading; "end" = after all body and child sections.' },
        },
        required: ['reason', 'filename', 'sectionPath', 'content', 'position'],
    },
};

export const KB_WRITE_TOOLS: LLMFunctionDeclaration[] = [
    REPLACE_FILE_TOOL,
    SEARCH_REPLACE_TOOL,
    REPLACE_SECTION_TOOL,
    INSERT_SECTION_TOOL,
    INSERT_INTO_SECTION_TOOL,
];

/** Tool names that mutate files. Centralised so the runtime can gate write
 *  tools when `context.readOnly` is true without duplicating the list. */
export const KB_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(KB_WRITE_TOOLS.map(t => t.name));

/** Error message returned to the LLM when a write tool fires on an
 *  agent surface that opted into `context.readOnly` (e.g. file-agent's
 *  chat-panel main surface where there is no editor view, so silent file
 *  mutations would be invisible to the user). Lives with KB_WRITE_TOOL_NAMES
 *  so any downstream agent that gates write tools reads from one place. */
export const READ_ONLY_REJECTION = 'This agent surface is read-only and cannot edit files — the user is on the main game screen, which has no editor view, so silent file mutations would be invisible to them. Do NOT retry write tools here. Use submitResponse to tell the user: open the KB editor (the file-viewer dialog from the sidebar) and re-issue the request there, where they can review and save the changes.';
