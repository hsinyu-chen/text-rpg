import { AppLocale } from './locale.interface';
import { GAME_INTENTS } from '../game-intents';

export const EN_US_LOCALE: AppLocale = {
    id: 'en-US',
    label: 'English',
    folder: 'en',
    responseSchema: {
        rootDescription: "Thinking Process: You MUST complete the 'analysis' field FIRST before generating the 'response' content. ALL OUTPUT MUST BE IN ENGLISH.",
        responseDescription: "[Response Phase] Contains the actual story content and logs after analysis. ALL FIELDS MUST BE IN ENGLISH.",
        analysis: `[Analysis Phase] REQUIRED. Must analyze Atomic Actions, Success/Failure Checks, and Random Events before generating the story. OUTPUT IN ENGLISH ONLY. Empty "" only if intent is ${GAME_INTENTS.SYSTEM} or ${GAME_INTENTS.SAVE}.`,
        summary: `[Summary] REQUIRED. Update key plot points for THIS turn only IN ENGLISH. Empty "" only if intent is ${GAME_INTENTS.SYSTEM} or ${GAME_INTENTS.SAVE}. CHECK HISTORY to avoid duplicates.`,
        character: "Encounters or state changes. Format: '[Tag] [Name/Desc] ([Details])'. Tags: New Character, Status Change, Location Update. CHECK HISTORY. Return [] if no changes.",
        inventory: "Item changes. Format: '[Tag]: [Name] / [Qty]'. Scene consumables (used in-place) NOT logged. ONLY log items in inventory file or history. Return [] if no changes.",
        quest: "Quest/Plan updates. Format: '[Tag]: [Quest Title] ([Details])'. ONLY record when quest is formally accepted, substantive progress made, or protagonist actively changes plan. CHECK HISTORY. Return [] if no changes.",
        world: "World developments. Format: '[Tag]: [Name/Event] ([Description])'. STRICTLY PROHIBIT logging content already in basic settings as new discoveries unless significant status change. CHECK HISTORY. Return [] if no changes."
    },
    actHeader: `
--- ACT START ---
[IMPORTANT] The following are the dialogue and state changes for the current ACT.
All previous states (including characters, items, landmarks, etc.) should be based on the Knowledge Base files ({{FILE_*}}).
All \`*_log\` content from this block until the end of the conversation represents incremental changes for this ACT.
When performing the <Save> command, please only compare and synchronize based on the changes after this block and the current file contents.
----------------
`,
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
        CONTINUE: 'Continue',
        POST_PROCESS: 'Post-Process'
    },
    intentTags: {
        ACTION: '<Action>',
        FAST_FORWARD: '<FastForward>',
        SYSTEM: '<System>',
        SAVE: '<Save>',
        CONTINUE: '<Continue>'
    },
    intentDescriptions: {
        ACTION: 'The main way to progress the story. AI determines success/failure based on skills and environment.',
        FAST_FORWARD: 'Skip dull periods. Stops if a special event (e.g., NPC visit) occurs.',
        SYSTEM: 'Story correction or questions. Used for OOC dialogue or questioning the plot.',
        SAVE: 'Analysis and state synchronization. Summarizes chapter and outputs XML file updates.',
        CONTINUE: 'Fluid progression. Used to wait for NPC reactions or observe environmental changes.'
    },
    inputPlaceholders: {
        ACTION: '([Mood]Action)Dialogue or Thoughts',
        FAST_FORWARD: 'Fast forward to specific time or event',
        SYSTEM: 'System command or setting adjustment',
        SAVE: 'Save current story progress',
        CONTINUE: 'Continue the story',
        FALLBACK: 'Enter your action...'
    },
    uiStrings: {
        GAME_INIT_SUCCESS: 'New game initialized!',
        GAME_INIT_FAILED: 'Startup Failed: Unable to load initial scene files.',
        MARKER_NOT_FOUND: '❌ Save Load Failed: Could not find `last_scene` marker in `{fileName}`, or file content is invalid. Loading status reset.',
        LOCAL_INIT_ANALYSIS: 'System Local Initialization: Extracted last scene from Story Outline.',
        CLOSE: 'Close',
        PROMPT_RESET_SUCCESS: 'Successfully reset "{type}" prompt.',
        ALL_PROMPTS_RESET_SUCCESS: 'Successfully reset all dynamic prompts.',
        INTRO_TEXT: 'Story begins, constructing the final scene',
        FORMAT_ERROR: '⚠️ Model output format anomaly, please retry.',
        GEN_FAILED: 'Generation Failed: {error}',
        CONN_ERROR: 'Connection error, please try again later.',
        ERR_PREFIX: '❌ Error: {error}',
        CORRECTION_SUCCESS: 'Story corrected (ID: {id})',
        CORRECTION_NOT_FOUND: 'Could not find story message to correct.',
        USER_NAME: 'Protagonist Name',
        USER_FACTION: 'Protagonist Faction',
        USER_BACKGROUND: 'Protagonist Background',
        USER_INTERESTS: 'Interests',
        USER_APPEARANCE: 'Appearance Description',
        USER_CORE_VALUES: 'Core Values & Behavior Guidelines',
        CREATE_NEW_GAME: 'Create New Game',
        SELECT_SCENARIO: 'Select Scenario',
        INITIALIZING: 'Initializing...',
        REQUIRED_FIELD: 'This field is required',
        SELECT_ALIGNMENT: 'Please select an alignment',
        CANCEL: 'Cancel',
        START_GAME: 'Start Game',
        ENTER_NAME: 'Enter name',
        CHAR_HISTORY_PLCH: 'Character history...',
        INTERESTS_PLCH: 'Interests...',
        APPEARANCE_PLCH: 'Appearance description...',
        CORE_VALUES_PLCH: 'Core values (Markdown format)...',
        DYNAMIC_PROMPT_SETTINGS: 'Dynamic Prompt Settings',
        SHOW_MENU: 'Show Menu',
        HIDE_MENU: 'Hide Menu',
        RESET_CURRENT: 'Reset Current Item',
        RESET_ALL: 'Reset All Items',
        INSTRUCTION_TYPE: 'Instruction Type',
        AUTO_INJECTION_HINT: 'Each instruction type will be automatically injected in the corresponding turn',
        ALIGNMENTS: {
            'Lawful Good': 'Lawful Good',
            'Neutral Good': 'Neutral Good',
            'Chaotic Good': 'Chaotic Good',
            'Lawful Neutral': 'Lawful Neutral',
            'True Neutral': 'True Neutral',
            'Chaotic Neutral': 'Chaotic Neutral',
            'Lawful Evil': 'Lawful Evil',
            'Neutral Evil': 'Neutral Evil',
            'Chaotic Evil': 'Chaotic Evil'
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
        POST_PROCESS_ERROR: 'Post-process script error: {error}',
        POST_PROCESS_HINT: 'User post-processing script (JavaScript) for transforming AI response content'
    }
};
