import { LLMFunctionDeclaration } from '@hcs/llm-core';
import { REASON_DESC } from './tool-helpers';

/**
 * Read-only tools that navigate / inspect KB markdown files. Safe to use on
 * any agent surface — never mutates state. Composable into any agent's tool
 * catalog by spreading `KB_READ_TOOLS` (or picking individual exports).
 */

export const READ_FILE_TOOL: LLMFunctionDeclaration = {
    name: 'readFile',
    description: 'Read a file (whole or by slice). PREFER grep first when looking for a specific pattern, and prefer getFileOutline + readSection for markdown navigation — readFile pulls raw bytes into context. Use this only when you genuinely need contiguous content. Pass startLine/lineCount to read a slice; omit both to read the whole file (forbidden on non-trivial files unless you have already located dense matches with grep, or the user explicitly asked to see the whole file).',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            filename: { type: 'string', description: 'The exact path of the file' },
            startLine: { type: 'number', description: '1-based starting line. Omit (or 1) to read from the beginning.' },
            lineCount: { type: 'number', description: 'Maximum number of lines to read from startLine. Omit to read to end of file.' },
        },
        required: ['reason', 'filename'],
    },
};

export const GET_FILE_OUTLINE_TOOL: LLMFunctionDeclaration = {
    name: 'getFileOutline',
    description: 'Get the heading outline of a markdown file',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            filename: { type: 'string', description: 'The exact path of the file' },
        },
        required: ['reason', 'filename'],
    },
};

export const GREP_TOOL: LLMFunctionDeclaration = {
    name: 'grep',
    description: 'Search for a JavaScript regex across files and return matching lines with their file path and 1-based line number. Cheaper than reading whole files when you only need to find where something is mentioned. **DEFAULTS to searching every file** when `filename` is omitted — this is the right mode for surveying scope (e.g. "where does identifier X appear?"); the response carries `filename` on each hit so you can stratify counts per file in your head. Only pass `filename` when you specifically need to scope to one file (e.g. verifying a post-write state of one file). When you plan to follow up with searchReplace, set contextLines to 1 or 2 so you can verify each hit is really what you want to mutate (avoid friendly-fire on edge cases like "---" inside code blocks or YAML front-matter).',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            pattern: { type: 'string', description: 'JavaScript regex source — no surrounding slashes, no inline flags. Example: "TODO|FIXME|脈衝".' },
            filename: { type: 'string', description: 'Optional. Restrict the search to this single file. Omit to search across all files.' },
            caseInsensitive: { type: 'boolean', description: 'Optional. Default false. Set true to search case-insensitively.' },
            maxResults: { type: 'number', description: 'Optional. Cap on the number of matches returned (default 100). Higher values risk filling the context window.' },
            contextLines: { type: 'number', description: 'Optional. Default 0. Number of surrounding lines to include before AND after each match (capped at 10). Each match gains "before" and "after" string arrays. Use 1-2 to sanity-check ambiguous patterns before searchReplace.' },
        },
        required: ['reason', 'pattern'],
    },
};

export const READ_SECTION_TOOL: LLMFunctionDeclaration = {
    name: 'readSection',
    description: 'Read one or more markdown sections by header path. Pass a single path as a one-element array. Returns the body (excluding the heading line) for each section. Output is capped at 500 lines total — check "truncated" on each result.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            filename: { type: 'string', description: 'The exact path of the file' },
            sectionPaths: {
                type: 'array',
                description: 'One or more header paths separated by ">", e.g. ["Character>Stats", "Character>Inventory"].',
                items: { type: 'string' },
            },
        },
        required: ['reason', 'filename', 'sectionPaths'],
    },
};

export const KB_READ_TOOLS: LLMFunctionDeclaration[] = [
    READ_FILE_TOOL,
    GET_FILE_OUTLINE_TOOL,
    GREP_TOOL,
    READ_SECTION_TOOL,
];
