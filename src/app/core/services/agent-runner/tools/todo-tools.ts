import { LLMFunctionDeclaration } from '@hcs/llm-core';
import { REASON_DESC } from './tool-helpers';

/**
 * Agent self-management tool — a sibling of the flow-control tools. Lets the
 * agent publish an ordered checklist of the steps for the current task; the
 * runtime mirrors it into a UI progress block. Handled generically by
 * BaseToolCallAgent (like reportProgress) — it mutates the agent's `todoList`
 * signal, never domain state — so any agent that adds it to its catalog gets
 * the behavior for free. Opt-in per agent.
 */
export const UPDATE_TODOS_TOOL: LLMFunctionDeclaration = {
    name: 'updateTodos',
    description:
        'Maintain a visible ordered checklist of the steps for the CURRENT task. '
        + 'RULE: before you start any task that takes more than one step, call this FIRST with the full plan, then work through it. Single-step requests (one read, one edit, one answer) do NOT need a todo list. '
        + 'Each call REPLACES the entire list — there is no separate add / mark-done / clear tool: to mark a step finished, resend the WHOLE list with that step\'s "done" set to true; to clear the list, send an empty "todos" array. '
        + 'The first item with "done": false (counting from the top) is shown to the user as the step currently in progress, so keep the order meaningful. '
        + 'IMPORTANT — update step by step: the moment you finish a step, call updateTodos again with that step marked "done": true (resend the whole list). Do this after EACH step as you go; do NOT leave the whole list unmarked until the end. This per-step update is what gives the user live progress. '
        + 'Keep steps short and outcome-oriented (e.g. "Grep all KB files for the old name", "Rewrite the intro section"). This does not end your turn.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            todos: {
                type: 'array',
                description: 'The FULL ordered checklist (replaces any previous list). Empty array clears it.',
                items: {
                    type: 'object',
                    properties: {
                        content: { type: 'string', description: 'Short description of this step.' },
                        done: { type: 'boolean', description: 'Optional. Default false. Set true once the step is finished.' },
                    },
                    required: ['content'],
                },
            },
        },
        required: ['todos'],
    },
};
