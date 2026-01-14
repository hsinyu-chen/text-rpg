import { AppLocale } from './locale.interface';
import { GAME_INTENTS } from '../game-intents';

export const ZH_TW_LOCALE: AppLocale = {
    id: 'Traditional Chinese',
    responseSchema: {
        rootDescription: "思考流程：你必須先完成 'analysis' 欄位，再生成 'response' 內容。所有輸出必須使用繁體中文。",
        responseDescription: "[回應階段] 分析後的實際故事內容與紀錄。所有欄位必須使用繁體中文。",
        analysis: `[分析階段] 必填。必須在生成故事前分析原子行動、成功/失敗檢定與隨機事件。必須使用繁體中文輸出。僅在意圖為 ${GAME_INTENTS.SYSTEM} 或 ${GAME_INTENTS.SAVE} 時可為空字串 ""。`,
        summary: `[摘要] 必填。僅更新本回合的關鍵劇情點，必須使用繁體中文。僅在意圖為 ${GAME_INTENTS.SYSTEM} 或 ${GAME_INTENTS.SAVE} 時可為空字串 ""。檢查歷史紀錄以避免重複。`,
        inventory: "描述本回合物品變化（獲得/失去/使用）的字串列表。必須使用繁體中文撰寫。檢查歷史紀錄以避免重複。若無變化則返回 []。",
        quest: "描述本回合新任務或計畫更新的字串列表。必須使用繁體中文撰寫。檢查歷史紀錄以避免重複。若無變化則返回 []。",
        world: "描述本回合世界事件、勢力動向、新地點或科技/魔法突破的字串列表。必須使用繁體中文撰寫。檢查歷史紀錄以避免重複。若無變化則返回 []。"
    },
    adultDeclaration: "*所有涉及情慾、性愛、裸露或性暗示之場景,角色皆已達成年年齡(滿18歲或當地法律定義之成年),且行為都經雙方同意,此劇情為完全虛構,無涉任何事實。*\n\n***\n\n",
    coreFilenames: {
        BASIC_SETTINGS: '1.基礎設定.md',
        STORY_OUTLINE: '2.劇情綱要.md',
        CHARACTER_STATUS: '3.人物狀態.md',
        ASSETS: '4.資產.md',
        TECH_EQUIPMENT: '5.科技裝備.md',
        WORLD_FACTIONS: '6.勢力與世界.md',
        MAGIC: '7.魔法.md',
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
        CONTINUE: '繼續'
    },
    inputPlaceholders: {
        ACTION: '([心境]動作)台詞或內心獨白',
        FAST_FORWARD: '快轉至特定時間點或事件',
        SYSTEM: '系統指令或設定調整',
        SAVE: '本輪劇情存檔',
        CONTINUE: '繼續劇情',
        FALLBACK: '輸入你的行動...'
    }
};
