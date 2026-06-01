import { describe, it, expect } from 'vitest';
import type { LLMFunctionDeclaration } from '@hcs/llm-core';
import { renderJsonModeBlock } from './json-tool-guide';

const SAMPLE: LLMFunctionDeclaration[] = [
    {
        name: 'readFile',
        description: 'Read a file (whole or by slice).',
        parameters: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'why' },
                filename: { type: 'string', description: 'The exact path of the file' },
                startLine: { type: 'number', description: '1-based starting line.' },
            },
            required: ['reason', 'filename'],
        },
    },
    {
        name: 'searchReplace',
        description: 'Apply pattern-based replacements.',
        parameters: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'why' },
                replacements: {
                    type: 'array',
                    description: 'one or more replacements',
                    items: {
                        type: 'object',
                        properties: {
                            pattern: { type: 'string', description: 'find' },
                            isRegex: { type: 'boolean', description: 'regex?' },
                        },
                        required: ['pattern'],
                    },
                },
            },
            required: ['reason', 'replacements'],
        },
    },
    {
        name: 'insertSection',
        description: 'Insert a section.',
        parameters: {
            type: 'object',
            properties: {
                anchor: { type: 'string', enum: ['prepend', 'before', 'after'], description: 'where' },
            },
            required: [],
        },
    },
    {
        name: 'readChatMessage',
        description: 'Read chat messages.',
        parameters: {
            type: 'object',
            properties: {
                include: {
                    type: 'array',
                    description: 'fields to include',
                    items: { type: 'string', enum: ['content', 'thought', 'logs'] },
                },
            },
            required: [],
        },
    },
];

describe('renderJsonModeBlock', () => {
    const out = renderJsonModeBlock(SAMPLE);

    it('includes the fixed JSON output-discipline header', () => {
        expect(out).toContain('## TOOL-CALL MODE — JSON');
        expect(out).toContain('pure JSON');
    });

    it('renders each tool name + its top-level description', () => {
        expect(out).toContain('### readFile');
        expect(out).toContain('Read a file (whole or by slice).');
        expect(out).toContain('### searchReplace');
        expect(out).toContain('Apply pattern-based replacements.');
    });

    it('marks required vs optional args and carries the arg description', () => {
        expect(out).toContain('- reason (string, required): why');
        expect(out).toContain('- filename (string, required): The exact path of the file');
        expect(out).toContain('- startLine (number, optional): 1-based starting line.');
    });

    it('recurses into array-of-object args, surfacing nested sub-fields', () => {
        expect(out).toContain('- replacements (object[], required): one or more replacements');
        // Nested item props are indented one level deeper.
        expect(out).toContain('    - pattern (string, required): find');
        expect(out).toContain('    - isRegex (boolean, optional): regex?');
    });

    it('renders enum args as a pipe-joined union of literals', () => {
        expect(out).toContain('- anchor ("prepend" | "before" | "after", optional): where');
    });

    it('surfaces array-of-enum item literals instead of a bare string[]', () => {
        expect(out).toContain('- include (("content" | "thought" | "logs")[], optional): fields to include');
    });
});
