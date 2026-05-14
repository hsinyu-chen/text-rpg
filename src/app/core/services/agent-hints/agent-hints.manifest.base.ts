import type { AgentHintEntry, AgentHintPathDecl } from './agent-hints.types';

/**
 * Hand-authored manifest entries that the AST generator cannot infer from
 * templates. Merged with `manifest.generated.ts` at runtime into the final
 * `AGENT_HINTS_MANIFEST`.
 *
 * Two flavours, both for paths the registry knows about but no single DOM
 * node owns:
 *
 *  - `VIRTUAL_HINTS` (tree): standalone subtrees whose root isn't in
 *    `GENERATED_HINTS`. Used for class-level actions fired programmatically
 *    via `registry.attachElement` (e.g. `chat-message/*` is registered by
 *    each chat-message row at runtime).
 *
 *  - `VIRTUAL_PATHS` (flat): leaf paths that live UNDER an existing
 *    generated container — per-instance buttons rendered inside `@for`
 *    loops where a static `appAgentHint` would race on attach (last render
 *    wins, earlier rows lose their reference). The registry surfaces a
 *    breadcrumb toast pointing the user at where the per-row button lives.
 *    Flat keeps the parent's activatable flag (owned by GENERATED) intact.
 *
 * Intermediate container paths are auto-filled by the merge step from
 * their children — list only the leaves you care about.
 */

export const VIRTUAL_HINTS: AgentHintEntry[] = [
  {
    id: 'chat-message',
    children: [
      { id: 'edit-resend' },
      { id: 'fork-from-here' },
      { id: 'delete-all-following' },
      { id: 'delete-message' },
      { id: 'toggle-ref-only' },
      { id: 'auto-update-files' },
      { id: 'copy-json-pair' },
      { id: 'toggle-raw-render' },
      { id: 'edit-text' },
    ],
  },
];

export const VIRTUAL_PATHS: AgentHintPathDecl[] = [
  // chat-input/view-turn-updates — toggles + add-item + clear-correction
  // live inside per-message turn-update components, N instances at once.
  { path: 'chat-input/view-turn-updates/toggle-inventory' },
  { path: 'chat-input/view-turn-updates/toggle-quest' },
  { path: 'chat-input/view-turn-updates/toggle-world' },
  { path: 'chat-input/view-turn-updates/toggle-character' },
  { path: 'chat-input/view-turn-updates/toggle-correction' },
  { path: 'chat-input/view-turn-updates/add-item' },
  { path: 'chat-input/view-turn-updates/clear-correction' },

  // sidebar/adventure-books — per-collection / per-book row actions.
  { path: 'sidebar/adventure-books/add-book' },
  { path: 'sidebar/adventure-books/rename-collection' },
  { path: 'sidebar/adventure-books/delete-collection' },
  { path: 'sidebar/adventure-books/move-book' },
  { path: 'sidebar/adventure-books/rename-book' },
  { path: 'sidebar/adventure-books/delete-book' },
  { path: 'sidebar/adventure-books/active-cache-badge' },
];
