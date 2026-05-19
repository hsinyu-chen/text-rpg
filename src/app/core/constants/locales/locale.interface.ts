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
    /**
     * Locale-specific KB section headings the multi-agent save dispatcher
     * pins context to. These are the heading TEXTS (no `#` prefix); the
     * dispatcher wraps them into the appropriate breadcrumb form.
     */
    kbSectionHeadings: {
        /**
         * L1 heading in `STORY_OUTLINE` under which ACT chronicle blocks are
         * appended. zh-tw: `劇情綱要`; en: `Story Outline`. The Story Outline
         * file ALSO has a `劇情引導` / `Story Guide` heading that must NOT
         * receive ACT entries — pinning the context to this exact heading
         * keeps the FileUpdateParser from appending to the wrong one.
         */
        STORY_OUTLINE_CHRONICLE: string;
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
     * `formatStructuredAnalysis`. Persisted into chat-message analysis text
     * — must match the locale the message was written in, so this layer is
     * keyed by `outputLanguage` (not `interfaceLanguage`).
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
        SCENE_CHANGE: string;
        PHYSICAL_STATE: string;
        PC_DIALOGUE: string;
        RISKS: string;
        OUTCOME: string;
        TRUNCATED_NOTE: string;
        NO_ACTION: string;
        NO_REACTION: string;
        NO_CHANGE: string;
    };
    /**
     * XML markers wrapped around user input before it's sent to the LLM, AND
     * reverse-mapped from saved chat messages on load (see
     * `LEGACY_INTENT_TAG_MAP` in session.service.ts). Engine-facing — must
     * stay tied to `outputLanguage` so saves from any historical locale
     * still migrate.
     */
    intentTags: {
        ACTION: string;
        FAST_FORWARD: string;
        SYSTEM: string;
        SAVE: string;
        CONTINUE: string;
    };
    /**
     * Strings the engine writes either as chat-message content (so they're
     * persisted alongside the story) or as prompt content sent back to the
     * LLM. NOT live UI chrome — UI strings live in
     * `src/app/core/i18n/dictionaries/` keyed by `interfaceLanguage`.
     */
    engineStrings: {
        /** Committed as chat-message content during local boot. */
        INTRO_TEXT: string;
        /** Written into `m.analysis` for system-init messages; equality-compared on load. */
        LOCAL_INIT_ANALYSIS: string;
        /** Sent back to the LLM at the head of the regenerate-save prompt. */
        REGENERATE_SAVE_PROMPT: string;
        /** Labels embedded in the regenerate-save prompt body. */
        REGEN_SUCCESS_TITLE: string;
        REGEN_FAILED_TITLE: string;
        REGEN_SUCCESS_LABEL: string;
        REGEN_FILE_LABEL: string;
        REGEN_ERROR_LABEL: string;
    };
}
