import { AppLocale } from './locale.interface';
import { GAME_INTENTS } from '../game-intents';

export const ZH_CN_LOCALE: AppLocale = {
    id: 'Simplified Chinese',
    responseSchema: {
        rootDescription: "思考流程：你必须先完成 'analysis' 栏位，再生成 'response' 内容。所有输出必须使用简体中文。",
        responseDescription: "[回应阶段] 分析后的实际故事内容与记录。所有栏位必须使用简体中文。",
        analysis: `[分析阶段] 必填。必须在生成故事前分析原子行动、成功/失败检定与随机事件。必须使用简体中文输出。仅在意图为 ${GAME_INTENTS.SYSTEM} 或 ${GAME_INTENTS.SAVE} 时可为空字符串 ""。`,
        summary: `[摘要] 必填。仅更新本回合的关键剧情点，必须使用简体中文。仅在意图为 ${GAME_INTENTS.SYSTEM} 或 ${GAME_INTENTS.SAVE} 时可为空字符串 ""。检查历史记录以避免重复。`,
        inventory: "描述本回合物品变化（获得/失去/使用）的字符串列表。必须使用简体中文撰写。检查历史记录以避免重复。若无变化则返回 []。",
        quest: "描述本回合新任务或计划更新的字符串列表。必须使用简体中文撰写。检查历史记录以避免重复。若无变化则返回 []。",
        world: "描述本回合世界事件、势力动向、新地点或科技/魔法突破的字符串列表。必须使用简体中文撰写。检查历史记录以避免重复。若无变化则返回 []。"
    },
    adultDeclaration: "*所有涉及情欲、性爱、裸露或性暗示之场景,角色皆已达成成年年龄(满18岁或当地法律定义之成年),且行为都经双方同意,此剧情为完全虚构,无涉任何事实。*\n\n***\n\n",
    coreFilenames: {
        BASIC_SETTINGS: '1.Base_Settings.md',
        STORY_OUTLINE: '2.Story_Outline.md',
        CHARACTER_STATUS: '3.Character_Status.md',
        ASSETS: '4.Assets.md',
        TECH_EQUIPMENT: '5.Tech_Equipment.md',
        WORLD_FACTIONS: '6.Factions_and_World.md',
        MAGIC: '7.Magic.md',
        PLANS: '8.Plans.md',
        INVENTORY: '9.Inventory.md'
    },
    promptHoles: {
        LANGUAGE_RULE: "必须使用简体中文进行创作。描写力求生动、细致。"
    },
    sectionHeaders: {
        START_SCENE: '## 开始场景',
        INPUT_FORMAT: '## 用户输入格式'
    },
    intentLabels: {
        ACTION: '行动',
        FAST_FORWARD: '快进',
        SYSTEM: '系统',
        SAVE: '存档',
        CONTINUE: '继续'
    },
    inputPlaceholders: {
        ACTION: '([心境]动作)台词或内心独白',
        FAST_FORWARD: '快进至特定时间点或事件',
        SYSTEM: '系统指令或设定调整',
        SAVE: '本轮剧情存档',
        CONTINUE: '继续剧情',
        FALLBACK: '输入你的行动...'
    }
};
