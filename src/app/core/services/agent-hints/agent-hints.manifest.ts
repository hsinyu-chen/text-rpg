import type { AgentHintEntry } from './agent-hints.types';

/**
 * Eager manifest of every UI feature the in-app helper agent should know
 * about. MUST be statically imported from the app bootstrap chain — not
 * from any lazy-loaded feature — so tree-shaking doesn't drop it and the
 * registry has a complete view at boot regardless of which dialogs/panels
 * have ever been opened.
 *
 * Structure: nested tree. `id` is the local segment (sibling-unique).
 * Full path = slash-joined ancestor chain, used as both the URL path
 * (`app://hint/<path>`) and the directive attribute (`appAgentHint="<path>"`).
 *
 * **Descriptions live in i18n dictionaries**, not here. Each entry's
 * description text is keyed `agentHint.<dotted-path>` (or
 * `agentHint.<dotted-path>.self` when the entry also has children).
 * Add new entries to:
 *   - `src/app/core/i18n/dictionaries/en.ts`  (canonical English)
 *   - `src/app/core/i18n/dictionaries/zh-tw.ts`  (zh-TW translation)
 *
 * Container vs leaf: containers describe an area/section and may not be
 * physically clickable on their own (no directive on the area div).
 * Leaves are real buttons/controls — directive sits on them when mounted.
 * Activatable leaves additionally bind `(hintActivate)` to a component
 * method so the registry can trigger them without sending synthetic DOM
 * events.
 */
export const AGENT_HINTS_MANIFEST: AgentHintEntry[] = [
  {
    id: 'chat-input',
    children: [
      {
        id: 'prompt-profile',
        activatable: true,
      },
      {
        id: 'engine-mode-toggle',
      },
      {
        id: 'ideal-outcome-toggle',
        activatable: true,
      },
      {
        id: 'save',
      },
      {
        id: 'chat-config',
        activatable: true,
        children: [
          { id: 'save-current' },
          { id: 'save-all' },
          { id: 'cloud-push' },
          { id: 'cloud-pull' },
          {
            id: 'profile-manage-menu',
            activatable: true,
            children: [
              { id: 'profile-clone' },
              { id: 'profile-rename' },
              { id: 'profile-delete' },
              { id: 'profile-export' },
              { id: 'profile-import' },
              { id: 'disk-sync-push' },
              { id: 'disk-sync-pull' },
              { id: 'change-disk-folder', activatable: true },
            ],
          },
        ],
      },
      {
        id: 'export-story',
      },
      {
        id: 'batch-replace',
        activatable: true,
        children: [
          { id: 'match-case', activatable: true },
          { id: 'whole-word', activatable: true },
          { id: 'regex', activatable: true },
          { id: 'filter-intent', activatable: true },
          { id: 'filter-role', activatable: true },
          { id: 'filter-field', activatable: true },
          { id: 'execute' },
        ],
      },
      {
        id: 'view-turn-updates',
        activatable: true,
        children: [
          { id: 'toggle-inventory', activatable: true },
          { id: 'toggle-quest', activatable: true },
          { id: 'toggle-world', activatable: true },
          { id: 'toggle-character', activatable: true },
          { id: 'toggle-correction', activatable: true },
          { id: 'add-item' },
          { id: 'clear-correction' },
        ],
      },
      {
        id: 'agent-panel',
        activatable: true,
      },
      {
        id: 'preview-payload',
        activatable: true,
      },
      {
        id: 'stop',
      },
      {
        id: 'send',
      },
      {
        id: 'cancel-edit',
      },
    ],
  },

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

  {
    id: 'sidebar',
    children: [
      {
        id: 'cost-prediction-toggle',
        activatable: true,
        children: [
          { id: 'compare-models', activatable: true },
          { id: 'copy-stats', activatable: true },
        ],
      },
      {
        id: 'adventure-books',
        activatable: true,
        children: [
          { id: 'add-book' },
          { id: 'rename-collection' },
          { id: 'delete-collection' },
          { id: 'move-book' },
          { id: 'rename-book' },
          { id: 'delete-book' },
          { id: 'active-cache-badge' },
        ],
      },
      {
        id: 'sync-provider',
        activatable: true,
      },
      {
        id: 'settings',
        activatable: true,
        children: [
          { id: 'select-llm-profile' },
          { id: 'manage-llm-profiles', activatable: true },
          { id: 'select-interface-language', activatable: true },
          { id: 'select-output-language' },
          { id: 'font-size', activatable: true },
        ],
      },
      {
        id: 'close-sidebar',
        activatable: true,
      },
      {
        id: 'provider-selector',
      },
      {
        id: 'files-tab',
        activatable: true,
        children: [
          { id: 'token-char-switch', activatable: true },
          {
            id: 'file-sync',
            children: [
              { id: 'select-folder', activatable: true },
              { id: 'change-folder', activatable: true },
            ],
          },
        ],
      },
      {
        id: 'session-tab',
        activatable: true,
        children: [
          {
            id: 'context',
            children: [
              { id: 'create-next' },
              { id: 'create-scene' },
              { id: 'edit-smart-context', activatable: true },
            ],
          },
          {
            id: 'start-session',
            activatable: true,
            children: [
              { id: 'select-scenario', activatable: true },
              { id: 'tab-prebuild', activatable: true },
              { id: 'tab-generate', activatable: true },
              { id: 'select-protagonist-gender', activatable: true },
              { id: 'reset-to-preset-identity' },
            ],
          },
        ],
      },
    ],
  },
];
