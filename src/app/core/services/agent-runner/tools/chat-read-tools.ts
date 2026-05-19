import { LLMFunctionDeclaration } from '@hcs/llm-core';
import { REASON_DESC } from './tool-helpers';

/**
 * Read tools that inspect the in-game chat history. Used by the file-agent
 * for cross-referencing narrative against KB state, and by save-sim
 * per-entity agents for pulling original event prose (NSFW details, magic
 * invention specifics, etc. that the condensed event summary loses).
 *
 * All tools require `context.chatMessages` to be populated; absence yields
 * a "no chat history available" error from the dispatcher.
 */

export const LIST_CHAT_MESSAGES_TOOL: LLMFunctionDeclaration = {
    name: 'listChatMessages',
    description: 'Outline of recent chat messages — cheap preview without bodies. Returns id, role, charCount, summary, intent, hasLogs. USE FIRST for any timing / sequence / pacing / "is X reasonable" question — summaries usually suffice. Also use first when the user references the story but no specific phrase. Paginate older with before=oldest-id-seen. Skips save-intent (engine file-update) turns by default. Errors if no chat history is available.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            limit: { type: 'number', description: 'Maximum number of messages to return, newest first (default 30, capped at 100).' },
            before: { type: 'string', description: 'Optional. Return only messages older than this message id. Use the oldest id from a prior call to paginate backwards.' },
            includeHidden: { type: 'boolean', description: 'Optional. Default false. Set true to include messages flagged isHidden (engine-suppressed system turns).' },
            includeSaves: { type: 'boolean', description: 'Optional. Default false. Set true ONLY if the user is asking about KB-write history itself — save-intent turns contain XML update tags, not narrative.' },
        },
        required: ['reason'],
    },
};

export const SEARCH_CHAT_MESSAGES_TOOL: LLMFunctionDeclaration = {
    name: 'searchChatMessages',
    description: 'Regex search across in-game chat messages — the chat-side analogue of grep. Returns hits with messageId, role, the scope that matched, and a snippet. Each message is capped at 3 hits (the 3rd carries moreInSameMessage:N) — multiple matches inside the same turn no longer dominate results. PREFER this over readChatMessage when you have a specific phrase, name, or token to find. For TIMING / SEQUENCE / pacing questions, listChatMessages with summaries is usually a cheaper first step. scope is REQUIRED and controls which field is searched — see the scope parameter docs for when to pick "content" / "thought" / "summary" / "all". For event-lookup questions ("when did X / who did Y") prefer "summary"; "content" is for verbatim phrase / quote / name lookups only. Save-intent turns are skipped by default. Tool errors if no chat history is available.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            pattern: { type: 'string', description: 'JavaScript regex source — no surrounding slashes, no inline flags. Note: in-game narrative may be in a different language than the user\'s question (see the Languages block in the system prompt) — match the narrative language, or use a language-agnostic token (proper name, number, identifier).' },
            scope: { type: 'string', enum: ['content', 'thought', 'summary', 'all'], description: 'REQUIRED. Each chat turn carries parallel fields — pick which to scan:\n  - "content": player-visible narrative prose (long-form story, dialogue, action). Use for phrase / quote / proper-name lookups.\n  - "thought": engine chain-of-thought (why this turn went the way it did). Use for "why did the engine decide X" questions.\n  - "summary": engine-emitted dense one-liner with structured event markers (typically pipe-separated actor-verb-object segments). Highest event density per byte; the most reliable hit when you do not know the exact phrasing the narrative used. Use for "when did X happen / who did Y / which turn ASSIGNED/GRANTED/COMPLETED Z" event-lookup questions — pattern-matching on narrative content often misses these because the canonical event verb only appears in summary.\n  - "all": scan content + thought + summary together. Use when uncertain.\nDecide by question shape, not by habit — content-only searches frequently miss event lookups.' },
            caseInsensitive: { type: 'boolean', description: 'Optional. Default false.' },
            limit: { type: 'number', description: 'Maximum hits to return across all messages (default 100, capped at 300).' },
            contextChars: { type: 'number', description: 'Optional. Default 80. Characters of context around each match in the returned snippet (capped at 400).' },
            includeSaves: { type: 'boolean', description: 'Optional. Default false. Set true ONLY if the user is asking about KB-write history itself.' },
        },
        required: ['reason', 'pattern', 'scope'],
    },
};

export const READ_CHAT_MESSAGE_TOOL: LLMFunctionDeclaration = {
    name: 'readChatMessage',
    description: 'Pinpoint-read one or more chat messages by id — the chat-side analogue of readSection. Pass a single id as a one-element array. Use AFTER listChatMessages / searchChatMessages narrow down which turn(s) matter; do not call this with guessed ids. "include" controls which fields come back per message — defaults to ["content"] to keep the response small. Add "thought" to see the model\'s reasoning, "logs" to inspect the *_log arrays (use readTurnLogs if logs are all you want), "analysis"/"summary"/"intent" for engine-computed fields. Tool errors if no chat history is available; per-id "not found" is reported inside the result, not as a top-level error.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            messageIds: {
                type: 'array',
                description: 'One or more chat message ids (from listChatMessages or searchChatMessages).',
                items: { type: 'string' },
            },
            include: {
                type: 'array',
                description: 'Fields to include per message. Default ["content"].',
                items: { type: 'string', enum: ['content', 'thought', 'logs', 'analysis', 'summary', 'intent'] },
            },
        },
        required: ['reason', 'messageIds'],
    },
};

export const READ_TURN_LOGS_TOOL: LLMFunctionDeclaration = {
    name: 'readTurnLogs',
    description: 'Read the structured per-turn logs (character_log / world_log / inventory_log / quest_log) — these are entries the engine wrote to KB during that turn, the most common ground truth for "the chat says X happened but the KB file says Y" fixes. Returns flattened entries grouped by message + kind. Pass messageIds to inspect specific turns; omit messageIds and use "recent" to scan the latest N turns. "kinds" filters which log types come back. Tool errors if no chat history is available.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            messageIds: { type: 'array', description: 'Optional. Specific message ids to inspect. If omitted, falls back to the latest "recent" turns.', items: { type: 'string' } },
            kinds: { type: 'array', description: 'Optional. Which log types to include. Default: all four (character, world, inventory, quest).', items: { type: 'string', enum: ['character', 'world', 'inventory', 'quest'] } },
            recent: { type: 'number', description: 'Optional. Only used when messageIds is omitted. Number of latest messages to scan (default 20, capped at 100).' },
        },
        required: ['reason'],
    },
};

export const CHAT_READ_TOOLS: LLMFunctionDeclaration[] = [
    LIST_CHAT_MESSAGES_TOOL,
    SEARCH_CHAT_MESSAGES_TOOL,
    READ_CHAT_MESSAGE_TOOL,
    READ_TURN_LOGS_TOOL,
];
