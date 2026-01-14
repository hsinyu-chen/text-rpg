export interface AppLocale {
    id: string;
    responseSchema: {
        rootDescription: string;
        responseDescription: string;
        analysis: string;
        summary: string;
        inventory: string;
        quest: string;
        world: string;
    };
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
    sectionHeaders: {
        START_SCENE: string;
        INPUT_FORMAT: string;
    };
    intentLabels: {
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
}
