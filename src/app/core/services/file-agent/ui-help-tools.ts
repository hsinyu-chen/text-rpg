import { LLMFunctionDeclaration } from '@hcs/llm-core';
import { REASON_DESC } from '../agent-runner/tools/tool-helpers';

/**
 * file-agent–specific tools that surface app-level UI structure (uiMap) and
 * library state (listBooks / listCollections). Not part of the generic
 * agent-runner tool catalogs because they depend on
 * `AgentHintRegistry` / `BookRepository` / `CollectionService` snapshots
 * that the chat-side file-agent injects via `FileAgentContext` — save-sim
 * agents don't have or want these.
 */

export const UI_MAP_TOOL: LLMFunctionDeclaration = {
    name: 'uiMap',
    description: 'Return the FULL UI feature tree (every button / panel / dialog the helper knows about). Call ONCE per turn when the user asks about UI locations or controls — the response is an indented markdown tree of `path — name — description` lines. Emit deep links as `app://hint/<full-path>` (e.g. `app://hint/chat-input/chat-config/profile-manage-menu/disk-sync-pull`); the markdown renderer auto-expands them into per-segment clickable breadcrumbs, so DO NOT manually compose `[A](app://hint/A) > [B](...)` chains. Append `?do=activate` only on entries marked `(activatable)` AND when the user explicitly asked you to trigger the action for them; default to plain URLs (highlight on click).',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
        },
        required: ['reason'],
    },
};

export const LIST_BOOKS_TOOL: LLMFunctionDeclaration = {
    name: 'listBooks',
    description: 'List all books (game saves) in the user\'s library — id, name, collection, last-active timestamp, turn count, isActive flag. Use when the user references a book by name ("the elf playthrough", "yesterday\'s save") or asks to compare / inspect a non-active book. Pair the returned ids with `app://book/<id>[/<action>]` URLs to give the user clickable deep-links into the sidebar.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
            collectionId: { type: 'string', description: 'Optional. Filter to one collection only (use the id from listCollections; "root" is the built-in unsorted folder).' },
            limit: { type: 'number', description: 'Optional. Max books to return, newest activity first. Default 50, capped at 200.' },
        },
        required: ['reason'],
    },
};

export const LIST_COLLECTIONS_TOOL: LLMFunctionDeclaration = {
    name: 'listCollections',
    description: 'List all book collections (folders) in the user\'s library — id, name, book count, isRoot flag. Use when the user references a collection by name ("the side-stories folder") or asks to add a book under one. Pair the returned ids with `app://collection/<id>[/<action>]` URLs for clickable deep-links. Root collection is the built-in unsorted folder; the agent cannot rename or delete it.',
    parameters: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: REASON_DESC },
        },
        required: ['reason'],
    },
};

export const UI_HELP_TOOLS: LLMFunctionDeclaration[] = [
    UI_MAP_TOOL,
    LIST_BOOKS_TOOL,
    LIST_COLLECTIONS_TOOL,
];
