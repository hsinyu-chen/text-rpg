/**
 * Shared description text injected into every file-operation tool's `reason`
 * parameter. Kept here so the wording stays in sync across read / write / chat
 * tool catalogs — the agent's user-visible action trace shows the model's
 * stated `reason` as a one-line caption, so this is the contract that
 * teaches the model what to put there.
 */
export const REASON_DESC = 'One sentence explaining WHY you are calling this tool right now — what you intend to find or change, and how it advances the current task. Required so you (and the user) can re-read the action trace later and follow your reasoning. Avoid restating the file name or echoing the tool name.';
