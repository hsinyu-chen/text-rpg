import { LLMFunctionDeclaration } from '@hcs/llm-core';

/**
 * Flow-control tools used by user-facing agents to communicate with the
 * human (`reportProgress` is mid-turn, `submitResponse` is terminal).
 * Save-sim per-entity agents do NOT use these — they have their own
 * terminal tools (`proposeDiff` / `commitNoChange`) that return diffs
 * to the dispatcher rather than text to the user.
 */

export const REPORT_PROGRESS_TOOL: LLMFunctionDeclaration = {
    name: 'reportProgress',
    description: 'Send a progress update to the user mid-task. The agent CONTINUES after this call — use it to narrate ongoing work without yielding control. Do NOT use this when the entire task is complete.',
    parameters: {
        type: 'object',
        properties: { message: { type: 'string', description: 'Short progress note to show to the user' } },
        required: ['message'],
    },
};

export const SUBMIT_RESPONSE_TOOL: LLMFunctionDeclaration = {
    name: 'submitResponse',
    description: 'End the agent turn and hand control back to the user. Call this ONLY when (a) the entire task is fully complete and you want to summarize, (b) you need to ask the user a question or need clarification, or (c) you are blocked and cannot proceed. After this call the agent stops and the user must type a new message to resume.',
    parameters: {
        type: 'object',
        properties: { message: { type: 'string', description: 'The final summary, question, or clarification to show to the user' } },
        required: ['message'],
    },
};

export const FLOW_CONTROL_TOOLS: LLMFunctionDeclaration[] = [
    REPORT_PROGRESS_TOOL,
    SUBMIT_RESPONSE_TOOL,
];
