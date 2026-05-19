import { LLMFunctionDeclaration } from '@hcs/llm-core';
import { REASON_DESC } from '../agent-runner/tools/tool-helpers';

/**
 * file-agent–specific tool that opens an approval-gated chat-wide
 * find/replace dialog. Lives in file-agent/ (not the shared agent-runner
 * catalogs) because it requires a `MatDialog`-backed `proposers.chatReplace`
 * closure on `FileAgentContext` — and is gated to the `main` agent surface
 * (file-edit surface returns an error).
 */
export const PROPOSE_CHAT_REPLACE_TOOL: LLMFunctionDeclaration = {
    name: 'proposeChatReplace',
    description: 'Propose a batch find/replace across the in-game chat messages, gated behind user approval. Opens a prefilled chat-replace dialog that the user can review, adjust, or cancel — the replacement only happens when the user clicks Replace All. Returns the outcome so you can see what actually happened (`applied` carries the final search/replace + filters + replaceCount, or is null when the user cancelled; `divergedFromProposal` flags whether the user changed any field before applying). Only available on the `main` agent surface (chat panel / PiP) — calling from the `file-edit` surface returns an error. Do NOT use this tool to "preview" a search; the dialog itself is the preview, and opening it interrupts the user.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            search: { type: 'string', description: 'The string or regex to find. With regex=false (default) this is matched literally. With regex=true this is a JavaScript regex source — no surrounding slashes, no inline flags.' },
            replace: { type: 'string', description: 'The string to replace each match with. Pass "" to delete matches. With regex=true, $1/$2/$& backreferences are honored.' },
            caseSensitive: { type: 'boolean', description: 'Optional. Default false (case-insensitive).' },
            wholeWord: { type: 'boolean', description: 'Optional. Default false. Only meaningful with regex=false — wraps the search in word boundaries.' },
            regex: { type: 'boolean', description: 'Optional. Default false. Set true to treat `search` as a JavaScript regex.' },
            intentFilter: { type: 'string', enum: ['all', 'action', 'continue', 'fast_forward', 'system', 'save'], description: 'Optional. Default "all". Restrict to messages with this intent.' },
            roleFilter: { type: 'string', enum: ['all', 'user', 'model'], description: 'Optional. Default "all". Restrict to user or model messages.' },
            fieldFilter: { type: 'string', enum: ['all', 'story', 'summary', 'logs'], description: 'Optional. Default "all". Which field of each message to scan: story=narrative content, summary=engine summary, logs=structured inventory/quest/world logs.' },
        },
        required: ['reason', 'search', 'replace'],
    },
};
