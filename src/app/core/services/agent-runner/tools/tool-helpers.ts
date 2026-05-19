/**
 * Shared description text injected into every file-operation tool's `reason`
 * parameter. Kept here so the wording stays in sync across read / write / chat
 * tool catalogs — the agent's user-visible action trace shows the model's
 * stated `reason` as a one-line caption, so this is the contract that
 * teaches the model what to put there.
 */
export const REASON_DESC = 'One sentence explaining WHY you are calling this tool right now — what you intend to find or change, and how it advances the current task. Required so you (and the user) can re-read the action trace later and follow your reasoning. Avoid restating the file name or echoing the tool name.';

/**
 * Coerce an LLM-supplied numeric arg into a bounded int. JSON-mode tool calls
 * are not schema-validated before reaching here, so a stringy "abc" or null
 * would slip into Math.floor → NaN and then bypass Math.min/Math.max
 * (NaN propagates through both). Treat null/undefined/non-finite as "missing,
 * use default" while still respecting an explicit 0 (e.g. contextChars: 0).
 */
export function clampInt(value: unknown, min: number, max: number, defaultValue: number): number {
    if (value === undefined || value === null) return defaultValue;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.min(max, Math.max(min, Math.floor(n)));
}
