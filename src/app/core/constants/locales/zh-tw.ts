import { AppLocale } from './locale.interface';
import { GAME_INTENTS } from '../game-intents';

export const ZH_TW_LOCALE: AppLocale = {
    id: 'zh-TW',
    label: 'Traditional Chinese (繁體中文)',
    folder: 'zh-tw',
    responseSchema: {
        rootDescription: "思考流程：你必須先完成 'analysis' 欄位，再生成 'response' 內容。所有輸出必須使用繁體中文。",
        responseDescription: "[回應階段] 分析後的實際故事內容與紀錄。所有欄位必須使用繁體中文。",
        analysis: `[分析階段] 必填。必須在生成故事前分析原子行動、成功/失敗檢定與隨機事件。必須使用繁體中文輸出。僅在意圖為 ${GAME_INTENTS.SYSTEM} 或 ${GAME_INTENTS.SAVE} 時可為空字串 ""。`,
        summary: `[摘要] 必填。僅更新本回合的關鍵劇情點，必須使用繁體中文。僅在意圖為 ${GAME_INTENTS.SYSTEM} 或 ${GAME_INTENTS.SAVE} 時可為空字串 ""。檢查歷史紀錄以避免重複。`,
        character: "描述人物變化。格式：'[標籤] [姓名/描述] ([內容])'。標籤：新角色/狀態變化/位置更新。檢查歷史紀錄。若無變化則返回 []。",
        inventory: "描述物品變化。格式：'[標籤]: [名稱] / [數量]'。場景內直接消耗的物資不記錄。只記錄存在於物品欄或歷史紀錄中的物品變動。若無變化則返回 []。",
        quest: "描述任務進度。格式：'[標籤]: [任務標題]（[具體進展描述]）'。僅在任務正式接受、進度實質變更、或主角主動改變計畫時記錄。檢查歷史紀錄。若無變化則返回 []。",
        world: "描述世界動向。格式：'[標籤]: [名稱/事件]（[詳述說明]）'。嚴禁將已存在於基礎設定的內容標記為新發現，除非狀態有重大變更。檢查歷史紀錄。若無變化則返回 []。"
    },
    actHeader: `
--- ACT START ---
[重要說明] 以下是本次 ACT 的劇情對白與狀態變動日誌。
所有先前的狀態（包括人物、物品、地標等）皆應以知識庫檔案（{{FILE_*}}）為準。
本區塊以後、直到對話結尾的所有 \`*_log\` 內容，代表本次 ACT 的增量變動。
在進行 <存檔> 指令時，請僅依據本區塊後的變動與目前檔案內容進行比對同步。
----------------
`,
    adultDeclaration: "*所有涉及情慾、性愛、裸露或性暗示之場景,角色皆已達成年年齡(滿18歲或當地法律定義之成年),且行為都經雙方同意,此劇情為完全虛構,無涉任何事實。*\n\n***\n\n",
    coreFilenames: {
        BASIC_SETTINGS: '1.基礎設定.md',
        STORY_OUTLINE: '2.劇情綱要.md',
        CHARACTER_STATUS: '3.人物狀態.md',
        ASSETS: '4.資產.md',
        TECH_EQUIPMENT: '5.科技裝備.md',
        WORLD_FACTIONS: '6.勢力與世界.md',
        MAGIC: '7.魔法與技能.md',
        PLANS: '8.計畫.md',
        INVENTORY: '9.物品欄.md'
    },
    promptHoles: {
        LANGUAGE_RULE: "必須使用繁體中文進行創作，嚴禁使用中國用語，如 當前(目前),數據(資料)....等等。"
    },
    sectionHeaders: {
        START_SCENE: '## 開始場景',
        INPUT_FORMAT: '## 使用者輸入格式'
    },
    intentLabels: {
        ACTION: '行動',
        FAST_FORWARD: '快轉',
        SYSTEM: '系統',
        SAVE: '存檔',
        CONTINUE: '繼續',
        POST_PROCESS: '後處理'
    },
    intentTags: {
        ACTION: '<行動意圖>',
        FAST_FORWARD: '<快轉>',
        SYSTEM: '<系統>',
        SAVE: '<存檔>',
        CONTINUE: '<繼續>'
    },
    intentDescriptions: {
        ACTION: '推進劇情的主要方式。AI 會根據能力、環境與隨機事件判定成敗。',
        FAST_FORWARD: '跳過平淡時段。若期間發生特別事件（如 NPC 拜訪）會自動停止。',
        SYSTEM: '劇情修正或提問。用於 OOC 對話或對劇情提出質疑。',
        SAVE: '分析並同步狀態。總結本章節並輸出 XML 格式的檔案更新。',
        CONTINUE: '自然推進。用於等待 NPC 反應或觀察環境變化。若主角處於無意識狀態（昏迷、熟睡等），將自動推進至恢復意識為止。'
    },
    inputPlaceholders: {
        ACTION: '([心境]動作)台詞或內心獨白',
        FAST_FORWARD: '快轉至特定時間點或事件',
        SYSTEM: '系統指令或設定調整',
        SAVE: '本輪劇情存檔',
        CONTINUE: '繼續故事',
        FALLBACK: '輸入你的行動...'
    },
    uiStrings: {
        GAME_INIT_SUCCESS: '新遊戲初始化完成！',
        GAME_INIT_FAILED: '啟動失敗：無法載入初始場景檔案。',
        MARKER_NOT_FOUND: '❌ 存檔載入失敗：在 `{fileName}` 中找不到 `last_scene` 標記，或檔案內容無效。已重設載入狀態。',
        LOCAL_INIT_ANALYSIS: '系統本地初始化：已從劇情綱要讀取最後場景。',
        CLOSE: '關閉',
        PROMPT_RESET_SUCCESS: '已重置「{type}」指令提示',
        ALL_PROMPTS_RESET_SUCCESS: '已重置所有動態提示',
        INTRO_TEXT: '劇情開始，建構最後的場景',
        FORMAT_ERROR: '⚠️ 模型輸出格式異常，請重試。',
        GEN_FAILED: '生成失敗: {error}',
        CONN_ERROR: '連線發生錯誤，請稍後再試。',
        ERR_PREFIX: '❌ 發生錯誤: {error}',
        CORRECTION_SUCCESS: '劇情已修正 (ID: {id})',
        CORRECTION_NOT_FOUND: '找不到可修正的劇情訊息。',
        USER_NAME: '主角名稱',
        USER_FACTION: '主角陣營',
        USER_BACKGROUND: '主角背景',
        USER_INTERESTS: '興趣',
        USER_APPEARANCE: '外貌描述',
        USER_CORE_VALUES: '核心價值觀與行為準則',
        CREATE_NEW_GAME: '創建新遊戲',
        SELECT_SCENARIO: '選擇腳本',
        INITIALIZING: '初始化中...',
        REQUIRED_FIELD: '此欄位必填',
        SELECT_ALIGNMENT: '請選擇一個陣營',
        CANCEL: 'Cancel',
        START_GAME: 'Start Game',
        ENTER_NAME: 'Enter Name',
        CHAR_HISTORY_PLCH: '人物歷史背景...',
        INTERESTS_PLCH: '興趣愛好...',
        APPEARANCE_PLCH: '外貌描述...',
        CORE_VALUES_PLCH: '核心價值（Markdown 格式）...',
        DYNAMIC_PROMPT_SETTINGS: '動態提示設定',
        SHOW_MENU: '顯示選單',
        HIDE_MENU: '隱藏選單',
        RESET_CURRENT: '重置目前項目',
        RESET_ALL: '重置所有項目',
        AUTO_INJECTION_HINT: '每個指令類型會在對應回合自動注入',
        ALIGNMENTS: {
            'Lawful Good': '守序善良',
            'Neutral Good': '中立善良',
            'Chaotic Good': '混亂善良',
            'Lawful Neutral': '守序中立',
            'True Neutral': '絕對中立',
            'Chaotic Neutral': '混難中立',
            'Lawful Evil': '守序邪惡',
            'Neutral Evil': '中立邪惡',
            'Chaotic Evil': '混亂邪惡'
        },
        BATCH_REPLACE: 'Batch Replace',
        SEARCH: 'Search',
        REPLACE: 'Replace',
        REPLACE_ALL: 'Replace All',
        REPLACE_COUNT: 'Replaced {count} occurrences',
        MATCH_COUNT: '{count} matches found',
        FILTER_INTENT: 'Intent Filter',
        FILTER_ROLE: 'Role Filter',
        FILTER_FIELD: 'Field Filter',
        FIELD_STORY: 'Story/Content',
        FIELD_SUMMARY: 'Summary',
        FIELD_LOGS: 'Logs (Inventory/Quest/World)',
        NO_MATCHES: 'No matches found',
        REPLACE_SUCCESS: 'Replacement completed successfully',
        ALL: 'All',
        ROLE_USER: 'User',
        ROLE_MODEL: 'Model',
        POST_PROCESS_ERROR: '後處理腳本錯誤: {error}',
        POST_PROCESS_HINT: '使用者後處理腳本 (JavaScript)，用於轉換 AI 回應內容',
        PROMPT_UPDATE_AVAILABLE: '提示詞有更新',
        PROMPT_UPDATE_TITLE: '提示詞更新對比',
        UPDATE: '更新',
        IGNORE: '忽略',
        SAVE: '儲存',
        SAVE_ALL: '全部儲存',
        SAVE_SUCCESS: '設定已成功儲存',
        SAVE_FAILED: '儲存設定失敗',
        SYSTEM_PROMPT_TITLE: '主系統提示 (system_prompt.md)',
        CATEGORY_MAIN: '主提示 (Main)',
        CATEGORY_INJECTION: '注入提示 (Injection)',
        CATEGORY_PROCESS: '處理腳本 (Process)',
        STOP_REASON_PREFIX: '模型停止原因：',
        REGENERATE_SAVE_BTN: '提示LLM重新產生',
        REGENERATE_SAVE_PROMPT: '重新產生完整存檔',
        STOP_GENERATION: '停止生成',
        STOP_GENERATION_CONFIRM_TITLE: '確認停止',
        STOP_GENERATION_CONFIRM_MSG: '確定要停止目前的生成嗎？'
    }
};
