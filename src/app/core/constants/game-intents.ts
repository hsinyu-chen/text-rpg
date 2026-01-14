/**
 * Centralized game intents for the TextRPG engine.
 * These are used for both logic control and display tags.
 */
export const GAME_INTENTS = {
    ACTION: '<行動意圖>',
    FAST_FORWARD: '<快轉>',
    SYSTEM: '<系統>',
    SAVE: '<存檔>',
    CONTINUE: '<繼續>'
} as const;

/**
 * Intents that contribute to the story progression.
 */
export const STORY_INTENTS = [
    GAME_INTENTS.ACTION,
    GAME_INTENTS.CONTINUE,
    GAME_INTENTS.FAST_FORWARD
];

/**
 * Type for Game Intents
 */
export type GameIntent = typeof GAME_INTENTS[keyof typeof GAME_INTENTS];
