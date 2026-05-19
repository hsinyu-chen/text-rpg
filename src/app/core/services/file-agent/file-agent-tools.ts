import { LLMFunctionDeclaration } from '@hcs/llm-core';
import {
    READ_FILE_TOOL,
    GET_FILE_OUTLINE_TOOL,
    GREP_TOOL,
    READ_SECTION_TOOL,
} from '../agent-runner/tools/kb-read-tools';
import {
    REPLACE_FILE_TOOL,
    SEARCH_REPLACE_TOOL,
    REPLACE_SECTION_TOOL,
    INSERT_SECTION_TOOL,
    INSERT_INTO_SECTION_TOOL,
} from '../agent-runner/tools/kb-write-tools';
import { CHAT_READ_TOOLS } from '../agent-runner/tools/chat-read-tools';
import { FLOW_CONTROL_TOOLS } from '../agent-runner/tools/flow-control-tools';
import { UI_HELP_TOOLS } from './ui-help-tools';
import { PROPOSE_CHAT_REPLACE_TOOL } from './propose-chat-replace-tool';

/**
 * Composed tool catalog for the chat-side file-agent. Order is preserved
 * from the pre-split single-file declaration so the model sees the same
 * tool sequence — tool ordering can subtly influence first-mention bias
 * in some model families.
 *
 * Composition rule: KB read+write are interleaved (historical order) for
 * file-agent specifically; downstream agents that want only read-side
 * tools should import `KB_READ_TOOLS` directly from the shared
 * `agent-runner/tools/kb-read-tools` catalog rather than try to slice
 * this composed array.
 */
export const FILE_AGENT_TOOLS: LLMFunctionDeclaration[] = [
    READ_FILE_TOOL,
    REPLACE_FILE_TOOL,
    GET_FILE_OUTLINE_TOOL,
    GREP_TOOL,
    SEARCH_REPLACE_TOOL,
    READ_SECTION_TOOL,
    REPLACE_SECTION_TOOL,
    INSERT_SECTION_TOOL,
    INSERT_INTO_SECTION_TOOL,
    ...CHAT_READ_TOOLS,
    ...UI_HELP_TOOLS,
    PROPOSE_CHAT_REPLACE_TOOL,
    ...FLOW_CONTROL_TOOLS,
];
