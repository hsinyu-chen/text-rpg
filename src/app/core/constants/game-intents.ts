/**
 * Centralized game intents for the TextRPG engine.
 * These are used for both logic control and display tags.
 */
export const GAME_INTENTS = {
    ACTION: 'action',
    FAST_FORWARD: 'fast_forward',
    SYSTEM: 'system',
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

/**
 * Marker intent on the save-trace message left after a current-act apply. NOT
 * a user-selectable intent (kept out of GAME_INTENTS so it never shows in the
 * picker). The chat's last message carrying this intent is the single source
 * of truth for the "pending act advance" lock: deleting that message unlocks,
 * creating the next act moves past it. Must differ from the legacy `'save'`
 * value, which `isLegacySaveMessage` strips on load.
 */
export const SAVE_TRACE_INTENT = 'save_trace';
