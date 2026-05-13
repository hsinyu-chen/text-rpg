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
    keywords: ['toolbar', '工具列', '底部'],
    children: [
      {
        id: 'prompt-profile',
        activatable: true,
        keywords: ['profile', 'prompt', '提示詞', '雲端', '本地'],
      },
      {
        id: 'engine-mode-toggle',
        keywords: ['engine', 'two-call', 'narrator', 'resolver', '引擎模式'],
      },
      {
        id: 'ideal-outcome-toggle',
        activatable: true,
        keywords: ['ideal', 'outcome', '理想結果', '期待'],
      },
      {
        id: 'save',
        keywords: ['save', '存檔', 'intent'],
      },
      {
        id: 'chat-config',
        activatable: true,
        keywords: ['config', '設定', '對話設定', 'profile', 'sync', '同步'],
        children: [
          { id: 'save-current' },
          { id: 'save-all' },
          { id: 'cloud-push', keywords: ['cloud', 'push', '雲端', '上傳'] },
          { id: 'cloud-pull', keywords: ['cloud', 'pull', '雲端', '下載'] },
          {
            id: 'profile-manage-menu',
            activatable: true,
            keywords: ['menu', 'profile', '管理', '選單'],
            children: [
              { id: 'profile-clone', keywords: ['clone', 'copy', 'duplicate', '複製'] },
              { id: 'profile-rename', keywords: ['rename', '改名', '重新命名'] },
              { id: 'profile-delete', keywords: ['delete', '刪除', '移除'] },
              { id: 'profile-export', keywords: ['export', '匯出', '備份'] },
              { id: 'profile-import', keywords: ['import', '匯入', '還原'] },
              { id: 'disk-sync-push', keywords: ['disk', 'sync', '同步', '資料夾'] },
              { id: 'disk-sync-pull', keywords: ['disk', 'sync', '同步'] },
              { id: 'change-disk-folder', activatable: true },
            ],
          },
        ],
      },
      {
        id: 'export-story',
        keywords: ['export', '匯出', '故事', 'markdown'],
      },
      {
        id: 'batch-replace',
        activatable: true,
        keywords: ['replace', '取代', '批次', 'find', 'search'],
        children: [
          { id: 'match-case', activatable: true, keywords: ['case'] },
          { id: 'whole-word', activatable: true, keywords: ['word'] },
          { id: 'regex', activatable: true, keywords: ['regex', '正規'] },
          { id: 'filter-intent', activatable: true },
          { id: 'filter-role', activatable: true },
          { id: 'filter-field', activatable: true },
          { id: 'execute', keywords: ['execute', '執行', 'apply'] },
        ],
      },
      {
        id: 'view-turn-updates',
        activatable: true,
        keywords: ['turn', 'update', 'log', '變化', 'inventory', 'quest'],
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
        keywords: ['agent', 'helper', '助手'],
      },
      {
        id: 'preview-payload',
        activatable: true,
        keywords: ['preview', 'payload', 'debug', 'prompt'],
      },
      {
        id: 'stop',
        keywords: ['stop', '中斷', 'cancel'],
      },
      {
        id: 'send',
        keywords: ['send', '送出', 'submit'],
      },
      {
        id: 'cancel-edit',
        keywords: ['cancel', '取消', 'edit'],
      },
    ],
  },

  {
    id: 'chat-message',
    keywords: ['message', '訊息', 'action', '動作'],
    children: [
      { id: 'edit-resend', keywords: ['edit', 'resend', '編輯', '重送'] },
      { id: 'fork-from-here', keywords: ['fork', '分支', '分歧'] },
      { id: 'delete-all-following', keywords: ['delete', '刪除'] },
      { id: 'delete-message', keywords: ['delete', '刪除'] },
      { id: 'toggle-ref-only', keywords: ['reference', '參考'] },
      { id: 'auto-update-files', keywords: ['auto', 'update', '自動更新'] },
      { id: 'copy-json-pair', keywords: ['copy', 'json'] },
      { id: 'toggle-raw-render', keywords: ['raw', 'render', '原始'] },
      { id: 'edit-text', keywords: ['edit', 'text', '編輯', '改寫', 'retcon'] },
    ],
  },

  {
    id: 'sidebar',
    keywords: ['sidebar', '側邊欄', '抽屜'],
    children: [
      {
        id: 'cost-prediction-toggle',
        activatable: true,
        keywords: ['cost', '費用', '預估'],
        children: [
          { id: 'compare-models', activatable: true, keywords: ['compare', '比較', 'model'] },
          { id: 'copy-stats', activatable: true, keywords: ['copy', 'stats'] },
        ],
      },
      {
        id: 'adventure-books',
        activatable: true,
        keywords: ['book', 'adventure', '冒險書', '存檔列表', 'collection', '集合'],
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
        keywords: ['sync', '同步', 'cloud', 's3', 'provider'],
      },
      {
        id: 'settings',
        activatable: true,
        keywords: ['settings', '設定', 'preferences', '偏好', '字型', '語言'],
        children: [
          { id: 'select-llm-profile' },
          { id: 'manage-llm-profiles', activatable: true },
          { id: 'select-interface-language', activatable: true },
          { id: 'select-output-language' },
          { id: 'font-size', activatable: true, keywords: ['font', '字型', '大小'] },
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
        keywords: ['files', 'tab', '檔案', '分頁'],
        children: [
          { id: 'token-char-switch', activatable: true },
          {
            id: 'file-sync',
            keywords: ['file', 'sync', '檔案', '同步', '資料夾'],
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
        keywords: ['session', 'tab', '會話', '分頁'],
        children: [
          {
            id: 'context',
            keywords: ['context', '上下文', '場景'],
            children: [
              { id: 'create-next' },
              { id: 'create-scene' },
              { id: 'edit-smart-context', activatable: true },
            ],
          },
          {
            id: 'start-session',
            activatable: true,
            keywords: ['new', 'game', 'start', '新遊戲', '開始', '建立'],
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
