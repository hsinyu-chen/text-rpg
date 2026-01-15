/**
 * Centralized game intents for the TextRPG engine.
 * These are used for both logic control and display tags.
 */
export const GAME_INTENTS = {
    ACTION: 'action',
    FAST_FORWARD: 'fast_forward',
    SYSTEM: 'system',
    SAVE: 'save',
    CONTINUE: 'continue'
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
