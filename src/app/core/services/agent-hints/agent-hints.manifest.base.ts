import type { AgentHintEntry } from './agent-hints.types';

/**
 * Hand-authored manifest entries that the AST generator cannot infer from
 * templates. Merged with `manifest.generated.ts` at runtime into the final
 * `AGENT_HINTS_MANIFEST`.
 *
 * Two distinct buckets:
 *  - `VIRTUAL_HINTS`: paths with NO DOM node — activated by component code
 *    (e.g. class-level message actions on `chat-message/*`). These are
 *    legitimate manifest entries; the registry treats them as unmounted
 *    breadcrumb targets and surfaces a toast pointing the user at the path.
 *
 *  - `PENDING_DIRECTIVES`: paths the manifest declares but no template has
 *    attached `appAgentHint` to the corresponding button yet. Each entry
 *    is a *short-term* placeholder — adding the directive to the template
 *    moves the path into `GENERATED_HINTS` and the entry should be removed
 *    from here. Empty array → delete this export entirely.
 *
 * Intermediate container paths (e.g. `sidebar/session-tab/context`) are
 * auto-filled by the merge step from their children — list only the leaf
 * paths you care about.
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

export interface PendingDirective {
  path: string;
  activatable?: boolean;
}

/**
 * Phase 0 worklist. Each entry corresponds to an existing UI button that
 * hasn't been tagged with `appAgentHint` yet. When you add the directive
 * to the template, delete the entry from here.
 *
 * **Progress meter:** `PENDING_DIRECTIVES.length`. Goal: 0.
 */
export const PENDING_DIRECTIVES: PendingDirective[] = [
  // chat-input/batch-replace dialog
  { path: 'chat-input/batch-replace/match-case', activatable: true },
  { path: 'chat-input/batch-replace/whole-word', activatable: true },
  { path: 'chat-input/batch-replace/regex', activatable: true },
  { path: 'chat-input/batch-replace/filter-intent', activatable: true },
  { path: 'chat-input/batch-replace/filter-role', activatable: true },
  { path: 'chat-input/batch-replace/filter-field', activatable: true },
  { path: 'chat-input/batch-replace/execute' },

  // chat-input/view-turn-updates panel
  { path: 'chat-input/view-turn-updates/toggle-inventory', activatable: true },
  { path: 'chat-input/view-turn-updates/toggle-quest', activatable: true },
  { path: 'chat-input/view-turn-updates/toggle-world', activatable: true },
  { path: 'chat-input/view-turn-updates/toggle-character', activatable: true },
  { path: 'chat-input/view-turn-updates/toggle-correction', activatable: true },
  { path: 'chat-input/view-turn-updates/add-item' },
  { path: 'chat-input/view-turn-updates/clear-correction' },

  // sidebar/cost-prediction-toggle panel
  { path: 'sidebar/cost-prediction-toggle/compare-models', activatable: true },
  { path: 'sidebar/cost-prediction-toggle/copy-stats', activatable: true },

  // sidebar/adventure-books panel (per-row actions, mostly class-level)
  { path: 'sidebar/adventure-books/add-book' },
  { path: 'sidebar/adventure-books/rename-collection' },
  { path: 'sidebar/adventure-books/delete-collection' },
  { path: 'sidebar/adventure-books/move-book' },
  { path: 'sidebar/adventure-books/rename-book' },
  { path: 'sidebar/adventure-books/delete-book' },
  { path: 'sidebar/adventure-books/active-cache-badge' },

  // sidebar/settings dialog
  { path: 'sidebar/settings/select-llm-profile' },
  { path: 'sidebar/settings/manage-llm-profiles', activatable: true },
  { path: 'sidebar/settings/select-interface-language', activatable: true },
  { path: 'sidebar/settings/select-output-language' },
  { path: 'sidebar/settings/font-size', activatable: true },

  // sidebar/session-tab/context controls (container auto-filled from children)
  { path: 'sidebar/session-tab/context/create-next' },
  { path: 'sidebar/session-tab/context/create-scene' },
  { path: 'sidebar/session-tab/context/edit-smart-context', activatable: true },

  // sidebar/session-tab/start-session dialog
  { path: 'sidebar/session-tab/start-session/select-scenario', activatable: true },
  { path: 'sidebar/session-tab/start-session/select-protagonist-gender', activatable: true },
  { path: 'sidebar/session-tab/start-session/reset-to-preset-identity' },
];
