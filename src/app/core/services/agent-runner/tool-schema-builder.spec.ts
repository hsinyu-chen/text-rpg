import { describe, expect, it } from 'vitest';
import { buildJsonSchema } from './tool-schema-builder';
import type { LLMFunctionDeclaration } from '@hcs/llm-core';

const FIXTURE_TOOLS: LLMFunctionDeclaration[] = [
    {
        name: 'readFile',
        description: 'Read a file',
        parameters: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'Why' },
                filename: { type: 'string', description: 'Path' },
                startLine: { type: 'number', description: 'Optional line' },
            },
            required: ['reason', 'filename'],
        },
    },
    {
        name: 'writeFile',
        description: 'Write a file',
        parameters: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'Why' },
                filename: { type: 'string', description: 'Path' },
                content: { type: 'string', description: 'New body' },
            },
            required: ['reason', 'filename', 'content'],
        },
    },
];

describe('buildJsonSchema — local (anyOf) mode', () => {
    it('emits one anyOf branch per tool', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, true) as { type: string; anyOf: unknown[] };
        expect(schema.type).toBe('object');
        expect(schema.anyOf).toHaveLength(2);
    });

    it('pins each branch action.enum to its single tool name', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, true) as { anyOf: { properties: { action: { enum: string[] } } }[] };
        expect(schema.anyOf[0].properties.action.enum).toEqual(['readFile']);
        expect(schema.anyOf[1].properties.action.enum).toEqual(['writeFile']);
    });

    it('strips descriptions off args properties (matches legacy hand-coded behavior)', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, true) as { anyOf: { properties: { args: { properties: Record<string, { description?: string }> } } }[] };
        const args = schema.anyOf[0].properties.args.properties;
        expect(args['reason']).toEqual({ type: 'string' });
        expect(args['filename']).toEqual({ type: 'string' });
        expect(args['startLine']).toEqual({ type: 'number' });
    });

    it('forces additionalProperties:false on each branch args (strict shape per tool for GBNF)', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, true) as { anyOf: { properties: { args: { additionalProperties: boolean } } }[] };
        for (const branch of schema.anyOf) {
            expect(branch.properties.args.additionalProperties).toBe(false);
        }
    });

    it('preserves required from the tool parameters', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, true) as { anyOf: { properties: { args: { required: string[] } } }[] };
        expect(schema.anyOf[0].properties.args.required).toEqual(['reason', 'filename']);
        expect(schema.anyOf[1].properties.args.required).toEqual(['reason', 'filename', 'content']);
    });

    it('marks the wrapper required fields (action + args)', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, true) as { anyOf: { required: string[] }[] };
        for (const branch of schema.anyOf) {
            expect(branch.required).toEqual(['action', 'args']);
        }
    });
});

describe('buildJsonSchema — cloud (flat union) mode', () => {
    it('lists every tool name in action.enum', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, false) as { properties: { action: { enum: string[] } } };
        expect(schema.properties.action.enum).toEqual(['readFile', 'writeFile']);
    });

    it('preserves reason description (the only canonical doc surface in cloud mode)', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, false) as { properties: { args: { properties: Record<string, { description?: string }> } } };
        expect(schema.properties.args.properties['reason'].description).toBe('Why');
    });

    it('strips descriptions on non-reason args properties', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, false) as { properties: { args: { properties: Record<string, { description?: string }> } } };
        expect(schema.properties.args.properties['filename'].description).toBeUndefined();
        expect(schema.properties.args.properties['content'].description).toBeUndefined();
    });

    it('unions args properties across all tools (first-key-wins for duplicates)', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, false) as { properties: { args: { properties: Record<string, unknown> } } };
        // reason + filename appear in both tools; content only in writeFile; startLine only in readFile
        expect(Object.keys(schema.properties.args.properties).sort()).toEqual(['content', 'filename', 'reason', 'startLine']);
    });

    it('emits the wrapper required = [action, args]', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, false) as { required: string[] };
        expect(schema.required).toEqual(['action', 'args']);
    });

    it('does NOT add additionalProperties:false on cloud args (suggestive, not enforcing)', () => {
        const schema = buildJsonSchema(FIXTURE_TOOLS, false) as { properties: { args: { additionalProperties?: boolean } } };
        expect(schema.properties.args.additionalProperties).toBeUndefined();
    });
});

describe('buildJsonSchema — fixes legacy hand-coded gap', () => {
    it('includes EVERY tool in the schema (legacy version silently omitted uiMap)', () => {
        // The pre-Pre-A hand-coded buildJsonSchema dropped uiMap from both
        // ACTION_ENUM and the anyOf union — uiMap was reachable in native
        // tool-call mode (via FILE_AGENT_TOOLS) but invisible in JSON mode.
        // Generic version walks the tool list and can't miss entries.
        const tools: LLMFunctionDeclaration[] = [
            { name: 'a', description: 'a', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
            { name: 'b', description: 'b', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
            { name: 'c', description: 'c', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
        ];
        const local = buildJsonSchema(tools, true) as { anyOf: unknown[] };
        const cloud = buildJsonSchema(tools, false) as { properties: { action: { enum: string[] } } };
        expect(local.anyOf).toHaveLength(3);
        expect(cloud.properties.action.enum).toEqual(['a', 'b', 'c']);
    });
});
