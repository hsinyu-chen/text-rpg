import { AppLocale } from './locale.interface';
import { GAME_INTENTS } from '../game-intents';

export const EN_US_LOCALE: AppLocale = {
    id: 'en-US',
    label: 'English',
    folder: 'en',
    responseSchema: {
        rootDescription: "Thinking Process: You MUST complete the 'analysis' field FIRST before generating the 'response' content. ALL OUTPUT MUST BE IN ENGLISH.",
        responseDescription: "[Response Phase] Contains the actual story content and logs after analysis. ALL FIELDS MUST BE IN ENGLISH.",
        analysis: `[Analysis Phase] REQUIRED. Must analyze Atomic Actions, Success/Failure Checks, and Random Events before generating the story. OUTPUT IN ENGLISH ONLY. Empty "" only if intent is ${GAME_INTENTS.SYSTEM}.`,
        summary: `[Summary] REQUIRED. Update key plot points for THIS turn only IN ENGLISH. Empty "" only if intent is ${GAME_INTENTS.SYSTEM}. CHECK HISTORY to avoid duplicates.`,
        character: "Encounters or state changes. Format: '[Tag] [Name/Desc] ([Details])'. Tags: New Character, Status Change, Location Update. CHECK HISTORY. Return [] if no changes.",
        inventory: "Item changes. Format: '[Tag]: [Name] / [Qty]'. Scene consumables (used in-place) NOT logged. ONLY log items in inventory file or history. Return [] if no changes.",
        quest: "Quest/Plan updates. Format: '[Tag]: [Quest Title] ([Details])'. ONLY record when quest is formally accepted, substantive progress made, or protagonist actively changes plan. CHECK HISTORY. Return [] if no changes.",
        world: "World developments. Format: '[Tag]: [Name/Event] ([Description])'. STRICTLY PROHIBIT logging content already in basic settings as new discoveries unless significant status change. CHECK HISTORY. Return [] if no changes."
    },
    actHeader: `
--- ACT START ---
[IMPORTANT] The following are the dialogue and state changes for the current ACT.
All previous states (including characters, items, landmarks, etc.) should be based on the Knowledge Base files.
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
        MAGIC: '7.Magic_and_Skills.md',
        PLANS: '8.Plans.md',
        INVENTORY: '9.Inventory.md'
    },
    kbSectionHeadings: {
        STORY_OUTLINE_CHRONICLE: 'Story Outline',
    },
    promptHoles: {
        LANGUAGE_RULE: "You MUST output ALL content in English. Use vivid, descriptive English prose."
    },
    enginePromptDirectives: {
        HISTORICAL_CORRECTION_RULE: `## Historical correction (top priority)

When chat history or stateUpdates summary contains a \`correction:\` entry, treat it as a **hard override** of prior story content:
- All fields (prose, \`*_log\`, step \`state_changes\` / \`target\`) must align with the correction; on conflict, the correction wins.
- Declared corrections persist across turns; they do not silently expire.
- The \`correction\` field is the single source of "reason / rule" — other fields write only the corrected final state, no \`校正\` / calibration markers, no recap of the correction process.`,
        IDEAL_OUTCOME_CONSTRAINT_TEMPLATE: `## User-declared ideal_outcome

The user has declared ideal_outcome as:
~~~
{0}
~~~

Do not infer — pass this value directly into the schema's \`ideal_outcome\` field (verbatim). All other rules for this field apply as usual.`
    },
    sectionHeaders: {
        START_SCENE: '## Start Scene',
        INPUT_FORMAT: '## User Input Format'
    },
    analysisTrace: {
        SCENE_HEADING: '[Scene]',
        TIME: 'Time',
        LOCATION: 'Location',
        PROTAGONIST: 'PC',
        PRESENT_NPCS: 'NPCs',
        ENVIRONMENT: 'Environment',
        KEY_OBJECTS: 'Key objects',
        INTENT_HEADING: '[Intent]',
        IDEAL_OUTCOME: 'Goal',
        IDEAL_STRENGTH: 'Strength',
        STEP_ACTION: 'Action',
        STEP_EVENT: 'Event',
        FULL_SCENE: 'Scene',
        SCENE_CHANGE: 'Scene change',
        PHYSICAL_STATE: 'Physical state',
        PC_DIALOGUE: 'PC',
        RISKS: 'Risks',
        OUTCOME: 'Outcome',
        TRUNCATED_NOTE: '(truncated after first break)',
        NO_ACTION: '(no action)',
        NO_REACTION: '(no reaction)',
        NO_CHANGE: 'unchanged'
    },
    intentTags: {
        ACTION: '<Action>',
        FAST_FORWARD: '<FastForward>',
        SYSTEM: '<System>',
        SAVE: '<Save>',
        CONTINUE: '<Continue>'
    },
    engineStrings: {
        INTRO_TEXT: 'Story begins, constructing the final scene',
        LOCAL_INIT_ANALYSIS: 'System Local Initialization: Extracted last scene from Story Outline.'
    }
};
