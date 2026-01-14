import { AppLocale } from './locale.interface';
import { GAME_INTENTS } from '../game-intents';

export const EN_US_LOCALE: AppLocale = {
    id: 'English',
    responseSchema: {
        rootDescription: "Thinking Process: You MUST complete the 'analysis' field FIRST before generating the 'response' content. ALL OUTPUT MUST BE IN ENGLISH.",
        responseDescription: "[Response Phase] Contains the actual story content and logs after analysis. ALL FIELDS MUST BE IN ENGLISH.",
        analysis: `[Analysis Phase] REQUIRED. Must analyze Atomic Actions, Success/Failure Checks, and Random Events before generating the story. OUTPUT IN ENGLISH ONLY. Empty "" only if intent is ${GAME_INTENTS.SYSTEM} or ${GAME_INTENTS.SAVE}.`,
        summary: `[Summary] REQUIRED. Update key plot points for THIS turn only IN ENGLISH. Empty "" only if intent is ${GAME_INTENTS.SYSTEM} or ${GAME_INTENTS.SAVE}. CHECK HISTORY to avoid duplicates.`,
        inventory: "List of strings describing item changes (gained/lost/used) in THIS turn ONLY. WRITE IN ENGLISH. CHECK HISTORY to avoid duplicates. Return [] if no changes.",
        quest: "List of strings describing new quests or plan updates in THIS turn ONLY. WRITE IN ENGLISH. CHECK HISTORY to avoid duplicates. Return [] if no changes.",
        world: "List of strings describing world events, faction moves, new locations, or tech/magic breakthroughs in THIS turn ONLY. WRITE IN ENGLISH. CHECK HISTORY to avoid duplicates. Return [] if no changes."
    },
    adultDeclaration: "*All scenes involving intimacy, sexuality, nudity, or sexual innuendo imply that all characters have reached the age of majority (18+ or as defined by local laws), and all acts are consensual. This story is purely fictional and unrelated to reality.*\n\n***\n\n",
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
        LANGUAGE_RULE: "You MUST output ALL content in English. Use vivid, descriptive English prose."
    },
    sectionHeaders: {
        START_SCENE: '## Start Scene',
        INPUT_FORMAT: '## User Input Format'
    },
    intentLabels: {
        ACTION: 'Action',
        FAST_FORWARD: 'Fast Forward',
        SYSTEM: 'System',
        SAVE: 'Save',
        CONTINUE: 'Continue'
    },
    inputPlaceholders: {
        ACTION: '([Mood]Action)Dialogue or Thoughts',
        FAST_FORWARD: 'Fast forward to specific time or event',
        SYSTEM: 'System command or setting adjustment',
        SAVE: 'Save current story progress',
        CONTINUE: 'Continue the story',
        FALLBACK: 'Enter your action...'
    }
};
