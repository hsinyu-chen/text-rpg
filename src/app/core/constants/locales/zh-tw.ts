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
所有先前的狀態（包括人物、物品、地標等）皆應以知識庫檔案為準。
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
        LANGUAGE_RULE: "必須使用繁體中文進行創作，嚴禁使用中國用語。"
    },
    enginePromptDirectives: {
        HISTORICAL_CORRECTION_RULE: `## 歷史 correction（最高優先）

history 訊息或 stateUpdates summary 出現 \`correction:\` 條目時，**必須**將其視為**硬性覆蓋**先前劇情的規則：
- 所有欄位（prose、\`*_log\`、step \`state_changes\`／\`target\`）都必須與 correction 一致；衝突時以 correction 為準。
- 已宣告的 correction 持續有效，不會自動失效。
- \`correction\` 欄位是「規則／原因」的單一來源；其他欄位只寫修正後的最終狀態，不要重述修正過程或加 \`校正\`／calibration 標籤。`,
        IDEAL_OUTCOME_CONSTRAINT_TEMPLATE: `## 使用者聲明的 ideal_outcome（最高優先）

使用者已聲明 ideal_outcome 為：
~~~
{0}
~~~

**必須**以此為基準判定每一步，**禁止**自行 infer。仍需 echo 該值到 schema 的 \`ideal_outcome\` 欄位（一字不漏）。`
    },
    sectionHeaders: {
        START_SCENE: '## 開始場景',
        INPUT_FORMAT: '## 使用者輸入格式'
    },
    analysisTrace: {
        SCENE_HEADING: '[現況]',
        TIME: '時間',
        LOCATION: '地點',
        PROTAGONIST: '主角',
        PRESENT_NPCS: '在場NPC',
        ENVIRONMENT: '環境',
        KEY_OBJECTS: '重要物件',
        INTENT_HEADING: '[意圖判讀]',
        IDEAL_OUTCOME: '目標',
        IDEAL_STRENGTH: '強度',
        STEP_ACTION: '動作',
        STEP_EVENT: '事件',
        FULL_SCENE: '全場景',
        PC_DIALOGUE: '主角',
        RISKS: '風險',
        OUTCOME: '判定',
        TRUNCATED_NOTE: '（首次中斷後截斷）',
        NO_ACTION: '（無動作）',
        NO_REACTION: '（無反應）',
        NO_CHANGE: '無變化'
    },
    intentTags: {
        ACTION: '<行動意圖>',
        FAST_FORWARD: '<快轉>',
        SYSTEM: '<系統>',
        SAVE: '<存檔>',
        CONTINUE: '<繼續>'
    },
    engineStrings: {
        INTRO_TEXT: '劇情開始，建構最後的場景',
        LOCAL_INIT_ANALYSIS: '系統本地初始化：已從劇情綱要讀取最後場景。',
        REGENERATE_SAVE_PROMPT: '以下存檔比對失敗。請務必找出正確的文字位置，並確保 <target> 內的文字與原始檔案「完全一致」（包含標點符號與縮排），否則將無法套用。請勿重複輸出已成功的部分。',
        REGEN_SUCCESS_TITLE: '**以下項目的 XML 更新「已成功」比對，請【絕對不要】再次輸出這些區塊：**',
        REGEN_FAILED_TITLE: '**請【僅針對】以下失敗項目重新產生 XML 更新：**',
        REGEN_SUCCESS_LABEL: '[已成功]',
        REGEN_FILE_LABEL: '[檔案]',
        REGEN_ERROR_LABEL: '[錯誤錨點] (檔案中找不到此段落，請重新定位文字並確保字元完全一致，包含標點與空格)：'
    }
};
