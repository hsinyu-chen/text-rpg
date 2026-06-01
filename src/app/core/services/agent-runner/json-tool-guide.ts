import { LLMFunctionDeclaration } from '@hcs/llm-core';

/**
 * Renders the JSON-mode tool documentation that the base loop appends to the
 * system instruction whenever a turn runs in JSON tool-call mode.
 *
 * Why this exists: in native mode the provider receives the full `tools`
 * array (names + descriptions + parameter schemas), so the model sees every
 * tool's usage strategy directly. In JSON mode the tools are converted to a
 * `responseSchema` by {@link import('./tool-schema-builder').buildJsonSchema},
 * which STRIPS all descriptions — so the only channel left to convey tool
 * strategy is the system-prompt text. This renderer reproduces, as text, the
 * same declaration content native mode already gets, from the single source
 * of truth (the `LLMFunctionDeclaration[]`). Agents therefore no longer hand-
 * maintain a per-agent JSON args guide.
 *
 * JSON mode only — native is unaffected (it reads the tools array natively).
 */

/** The slice of JSON Schema this renderer walks. Tool parameters are authored
 *  as plain JSON-schema literals, so a structural view is enough — no need to
 *  pull in a full schema type. */
interface SchemaNode {
    type?: string;
    description?: string;
    enum?: unknown[];
    items?: SchemaNode;
    properties?: Record<string, SchemaNode>;
    required?: string[];
}

const DISCIPLINE = `## TOOL-CALL MODE — JSON
Output a SINGLE valid JSON object shaped \`{ "action": "<toolName>", "args": { ... } }\` and NOTHING else — no prose, no markdown, no code fences before or after it.
CRITICAL: Do NOT use native tool-call tags like <tool_call|>, <|tool_call|>, or \`\`\`json. The response must be pure JSON starting with { and ending with }.
THINKING EFFICIENCY: Decide the action and arguments once — do NOT rehearse or redraft the JSON inside your thinking.
Most actions require a "reason" argument (marked required per tool below). When present, write it FIRST — one sentence on why you are calling this tool right now — to anchor your intent for later turns.
Never output dummy values like "..." or "null" for fields you do not need — omit the field entirely from the JSON object.`;

/**
 * Build the full JSON-mode block: the fixed output-discipline header followed
 * by one section per tool, rendered from the declarations.
 */
export function renderJsonModeBlock(tools: LLMFunctionDeclaration[]): string {
    const catalog = tools.map(renderTool).join('\n\n');
    return `${DISCIPLINE}\n\nTOOL CATALOG — pick exactly ONE action per turn:\n\n${catalog}`;
}

function renderTool(tool: LLMFunctionDeclaration): string {
    const lines: string[] = [`### ${tool.name}`];
    if (tool.description) lines.push(tool.description);
    const argLines = renderProps(tool.parameters as SchemaNode | undefined, 0);
    if (argLines.length) {
        lines.push('args:', ...argLines);
    } else {
        lines.push('args: {} (no arguments)');
    }
    return lines.join('\n');
}

/** One bullet per property; recurses one level into object / array-of-object
 *  args so nested shapes (searchReplace.replacements, replaceSection.updates)
 *  still surface their sub-fields. */
function renderProps(node: SchemaNode | undefined, depth: number): string[] {
    if (!node?.properties) return [];
    const required = new Set(node.required ?? []);
    const indent = '  '.repeat(depth + 1);
    const out: string[] = [];
    for (const [key, prop] of Object.entries(node.properties)) {
        const req = required.has(key) ? 'required' : 'optional';
        const desc = prop.description ? `: ${prop.description}` : '';
        out.push(`${indent}- ${key} (${typeLabel(prop)}, ${req})${desc}`);
        const sub = prop.type === 'array' ? prop.items : prop;
        if (sub?.properties) out.push(...renderProps(sub, depth + 1));
    }
    return out;
}

function typeLabel(prop: SchemaNode): string {
    if (prop.enum) return enumLabel(prop.enum);
    if (prop.type === 'array') {
        const it = prop.items;
        // Surface array-item enums (e.g. readChatMessage.include / readTurnLogs.kinds)
        // as `("a" | "b")[]` — otherwise the permitted literals vanish from the guide.
        const itType = it?.properties ? 'object' : it?.enum ? `(${enumLabel(it.enum)})` : (it?.type ?? 'any');
        return `${itType}[]`;
    }
    return prop.type ?? 'any';
}

function enumLabel(values: unknown[]): string {
    return values.map(e => JSON.stringify(e)).join(' | ');
}
