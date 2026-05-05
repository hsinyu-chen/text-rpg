export interface AppLocale {
    id: string;
    label: string;
    folder: string;
    responseSchema: {
        rootDescription: string;
        responseDescription: string;
        analysis: string;
        summary: string;
        character: string;
        inventory: string;
        quest: string;
        world: string;
    };
    actHeader: string;
    adultDeclaration: string;
    coreFilenames: {
        BASIC_SETTINGS: string;
        STORY_OUTLINE: string;
        CHARACTER_STATUS: string;
        ASSETS: string;
        TECH_EQUIPMENT: string;
        WORLD_FACTIONS: string;
        MAGIC: string;
        PLANS: string;
        INVENTORY: string;
    };
    promptHoles: {
        LANGUAGE_RULE: string;
    };
    /**
     * Prompt fragments injected into LLM context (NOT user-facing UI). Engine
     * behaviour, not profile style — both built-in and user profiles share
     * these. Keep model-facing strings here so they're versioned with the locale.
     */
    enginePromptDirectives: {
        /** Substituted into protocol_resolver / protocol_narrator's `{{HISTORICAL_CORRECTION_RULE}}` slot only when chat history carries a `correction:` entry. */
        HISTORICAL_CORRECTION_RULE: string;
        /** Substituted into protocol_resolver's `{{IDEAL_OUTCOME_CONSTRAINT}}` slot when the latest user msg supplied `userIdealOutcome`. The `{0}` token is replaced with that text. */
        IDEAL_OUTCOME_CONSTRAINT_TEMPLATE: string;
    };
    sectionHeaders: {
        START_SCENE: string;
        INPUT_FORMAT: string;
    };
    /**
     * Labels rendered into the "Atomic Breakdown & Check" trace panel by
     * `formatStructuredAnalysis`. Programmatic markdown — pick the locale by
     * the active `outputLanguage` so en users don't see Chinese headers and
     * vice versa.
     */
    analysisTrace: {
        SCENE_HEADING: string;
        TIME: string;
        LOCATION: string;
        PROTAGONIST: string;
        PRESENT_NPCS: string;
        ENVIRONMENT: string;
        KEY_OBJECTS: string;
        INTENT_HEADING: string;
        IDEAL_OUTCOME: string;
        IDEAL_STRENGTH: string;
        STEP_ACTION: string;
        STEP_EVENT: string;
        FULL_SCENE: string;
        PC_DIALOGUE: string;
        RISKS: string;
        OUTCOME: string;
        TRUNCATED_NOTE: string;
        NO_ACTION: string;
        NO_REACTION: string;
        NO_CHANGE: string;
    };
    intentLabels: {
        ACTION: string;
        FAST_FORWARD: string;
        SYSTEM: string;
        SAVE: string;
        CONTINUE: string;
        POST_PROCESS: string;
    };
    intentTags: {
        ACTION: string;
        FAST_FORWARD: string;
        SYSTEM: string;
        SAVE: string;
        CONTINUE: string;
    };
    intentDescriptions: {
        ACTION: string;
        FAST_FORWARD: string;
        SYSTEM: string;
        SAVE: string;
        CONTINUE: string;
    };
    inputPlaceholders: {
        ACTION: string;
        FAST_FORWARD: string;
        SYSTEM: string;
        SAVE: string;
        CONTINUE: string;
        FALLBACK: string;
    };
    uiStrings: {
        GAME_INIT_SUCCESS: string;
        GAME_INIT_FAILED: string;
        MARKER_NOT_FOUND: string;
        LOCAL_INIT_ANALYSIS: string;
        CLOSE: string;
        INTRO_TEXT: string;
        FORMAT_ERROR: string;
        GEN_FAILED: string;
        CONN_ERROR: string;
        ERR_PREFIX: string;
        CORRECTION_SUCCESS: string;
        CORRECTION_NOT_FOUND: string;
        USER_NAME: string;
        USER_FACTION: string;
        USER_BACKGROUND: string;
        USER_INTERESTS: string;
        USER_APPEARANCE: string;
        USER_CORE_VALUES: string;
        CREATE_NEW_GAME: string;
        SELECT_SCENARIO: string;
        INITIALIZING: string;
        REQUIRED_FIELD: string;
        SELECT_ALIGNMENT: string;
        CANCEL: string;
        START_GAME: string;
        ENTER_NAME: string;
        CHAR_HISTORY_PLCH: string;
        INTERESTS_PLCH: string;
        APPEARANCE_PLCH: string;
        CORE_VALUES_PLCH: string;
        DYNAMIC_PROMPT_SETTINGS: string;
        SHOW_MENU: string;
        HIDE_MENU: string;
        AUTO_INJECTION_HINT: string;
        ALIGNMENTS: Record<string, string>;
        BATCH_REPLACE: string;
        SEARCH: string;
        REPLACE: string;
        REPLACE_ALL: string;
        REPLACE_COUNT: string;
        MATCH_COUNT: string;
        FILTER_INTENT: string;
        FILTER_ROLE: string;
        FILTER_FIELD: string;
        FIELD_STORY: string;
        FIELD_SUMMARY: string;
        FIELD_LOGS: string;
        NO_MATCHES: string;
        REPLACE_SUCCESS: string;
        ALL: string;
        ROLE_USER: string;
        ROLE_MODEL: string;
        POST_PROCESS_ERROR: string;
        POST_PROCESS_HINT: string;
        PROMPT_UPDATE_AVAILABLE: string;
        PROMPT_UPDATE_TITLE: string;
        UPDATE: string;
        IGNORE: string;
        SAVE: string;
        SAVE_ALL: string;
        SAVE_SUCCESS: string;
        SAVE_FAILED: string;
        SYSTEM_PROMPT_TITLE: string;
        PROTOCOL_SINGLE_TITLE: string;
        PROTOCOL_RESOLVER_TITLE: string;
        PROTOCOL_NARRATOR_TITLE: string;
        LEGACY_PROFILE_BADGE_TIP: string;
        LEGACY_PROFILE_AUTOSWITCH: string;
        CATEGORY_MAIN: string;
        CATEGORY_INJECTION: string;
        CATEGORY_PROCESS: string;
        STOP_REASON_PREFIX: string;
        REGENERATE_SAVE_BTN: string;
        REGENERATE_SAVE_PROMPT: string;
        STOP_GENERATION: string;
        STOP_GENERATION_CONFIRM_TITLE: string;
        STOP_GENERATION_CONFIRM_MSG: string;
        PROMPT_PROFILE_LABEL: string;
        PROFILE_CLOUD: string;
        PROFILE_LOCAL: string;
        PROFILE_CLOUD_DESC: string;
        PROFILE_LOCAL_DESC: string;
        PROFILE_MANAGE_MENU: string;
        PROFILE_CLONE: string;
        PROFILE_CLONE_PROMPT: string;
        PROFILE_CLONE_TO_EDIT: string;
        PROFILE_CLONED: string;
        PROFILE_RENAME: string;
        PROFILE_RENAME_PROMPT: string;
        PROFILE_RENAMED: string;
        PROFILE_DELETE: string;
        PROFILE_DELETE_CONFIRM: string;
        PROFILE_DELETED: string;
        PROFILE_OP_FAILED: string;
        PROFILE_EXPORT: string;
        PROFILE_IMPORT: string;
        PROFILE_IMPORTED: string;
        PROFILE_IMPORT_EMPTY: string;
        PROFILE_IMPORT_INVALID: string;
        PROMPT_SYNC_PUSH: string;
        PROMPT_SYNC_PULL: string;
        PROMPT_SYNC_UPLOADING: string;
        PROMPT_SYNC_DOWNLOADING: string;
        PROMPT_SYNC_UPLOADED: string;
        PROMPT_SYNC_DOWNLOADED: string;
        PROMPT_SYNC_NONE_FOUND: string;
        PROMPT_SYNC_FAILED: string;
        PROMPT_SYNC_DOWNLOAD_TITLE: string;
        PROMPT_SYNC_DOWNLOAD_CONFIRM: string;
        DISK_SYNC_PUSH: string;
        DISK_SYNC_PULL: string;
        DISK_SYNC_PUSHING: string;
        DISK_SYNC_PULLING: string;
        DISK_SYNC_PUSHED: string;
        DISK_SYNC_PULLED: string;
        DISK_SYNC_PULL_EMPTY: string;
        DISK_SYNC_PULL_DISCARD_CONFIRM: string;
        DISK_SYNC_FAILED: string;
        DISK_SYNC_FOLDER_BOUND: string;
        DISK_SYNC_FOLDER_NOT_BOUND: string;
        PROFILE_READONLY_BANNER: string;
        PROFILE_SWITCH_DISCARD_CONFIRM: string;
        UNSAVED_CHANGES_CONFIRM: string;
        POST_PROCESS_INVALID_CONFIRM: string;
        REGEN_SUCCESS_TITLE: string;
        REGEN_FAILED_TITLE: string;
        REGEN_SUCCESS_LABEL: string;
        REGEN_FILE_LABEL: string;
        REGEN_ERROR_LABEL: string;
        CALIBRATE_TOOLTIP: string;
        CALIBRATE_MODE_TITLE: string;
        CALIBRATE_CONFIRM: string;
        CALIBRATE_CANCEL: string;
        IDEAL_OUTCOME_FIELD_LABEL: string;
        IDEAL_OUTCOME_FIELD_PLACEHOLDER: string;
        IDEAL_OUTCOME_CHIP_LABEL: string;
        IDEAL_OUTCOME_CHIP_PREFIX: string;
        IDEAL_OUTCOME_TOGGLE_TOOLTIP: string;
        ENGINE_MODE_SINGLE: string;
        ENGINE_MODE_TWO_CALL: string;
        ENGINE_MODE_TOGGLE_TOOLTIP: string;
    };
}
