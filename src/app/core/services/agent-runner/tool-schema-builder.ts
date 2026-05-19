import { LLMFunctionDeclaration } from '@hcs/llm-core';

/**
 * Builds the `responseSchema` payload that agents pass to providers when
 * running in JSON tool-call mode (i.e. when the model is asked to emit a
 * single JSON action object instead of a native function-call).
 *
 * Two output shapes:
 * - `isLocal=true` (llama.cpp / GBNF-constrained): an `anyOf` discriminated
 *   union — one branch per tool, each branch's `args` carries the tool's
 *   exact parameters + `additionalProperties: false`. This is what GBNF
 *   needs to actually constrain output; flat schemas don't compile
 *   tightly enough on local quants.
 * - `isLocal=false` (cloud): a single object schema with `action: enum`
 *   and a flat `args` properties union (first-key-wins across tools).
 *   Suggestive rather than enforcing — cloud structured-output APIs
 *   inspect the schema for hinting, not strict shape gating.
 *
 * Descriptions are stripped from the emitted args properties (the parent
 * `description` on the action/args wrapper is the canonical one). This
 * matches the prior hand-coded schema byte-for-byte so existing provider
 * behavior is preserved.
 */
export function buildJsonSchema(tools: LLMFunctionDeclaration[], isLocal: boolean): object {
    if (isLocal) {
        return { type: 'object', anyOf: buildLocalAnyOf(tools) };
    }
    return buildCloudUnion(tools);
}

function buildLocalAnyOf(tools: LLMFunctionDeclaration[]): unknown[] {
    return tools.map(tool => ({
        properties: {
            action: { type: 'string', enum: [tool.name] },
            args: {
                ...stripDescriptions(tool.parameters as Record<string, unknown>),
                additionalProperties: false,
            },
        },
        required: ['action', 'args'],
    }));
}

function buildCloudUnion(tools: LLMFunctionDeclaration[]): object {
    const actionNames = tools.map(t => t.name);
    const flatProperties: Record<string, unknown> = {};
    for (const tool of tools) {
        const params = tool.parameters as { properties?: Record<string, unknown> };
        if (!params.properties) continue;
        for (const [key, schema] of Object.entries(params.properties)) {
            if (key in flatProperties) continue;
            // 'reason' keeps its description because that's the only canonical
            // place it appears in cloud-mode schema (the args wrapper description
            // doesn't repeat what reason is for). All other keys lose their
            // descriptions — the args.description above is enough.
            flatProperties[key] = key === 'reason' ? schema : stripDescriptions(schema as Record<string, unknown>);
        }
    }
    return {
        type: 'object',
        properties: {
            action: { type: 'string', enum: actionNames, description: 'The tool to use.' },
            args: {
                type: 'object',
                description: 'Arguments for the tool. Required fields depend on the action. All file-operation actions also require a "reason" string.',
                properties: flatProperties,
            },
        },
        required: ['action', 'args'],
    };
}

/**
 * Recursively strips `description` keys from a schema-shaped object. Used
 * on tool args so the emitted responseSchema stays compact — descriptions
 * are already in the tool catalog passed to native-mode, and bloat the
 * JSON-mode prompt without adding compliance value (GBNF ignores them).
 */
function stripDescriptions(schema: unknown): unknown {
    if (schema === null || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(stripDescriptions);
    const cloned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === 'description') continue;
        cloned[key] = stripDescriptions(value);
    }
    return cloned;
}
