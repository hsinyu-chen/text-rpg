/**
 * Schema-version compatibility for the active prompt profile's `system_main`.
 *
 * The output-protocol spec used to live inside `system_prompt.md`. PR #25
 * extracted it into `injection_protocol_single.md` so v1 and v2 (two-call)
 * paths can share the same cache prefix while differing only in the
 * user-message tail. The new shipped `system_prompt.md` carries an
 * `@system-main-version: 2` HTML-comment marker right at the top to signal
 * "the protocol spec lives in the injection file, not here anymore."
 *
 * Custom profiles that were forked BEFORE PR #25 still have the old
 * `system_main` content with the protocol spec embedded. Without
 * detection, those profiles either:
 *   - send the protocol spec twice (once from their own system_main, once
 *     from the new injection) on the v1 path, or
 *   - send a v1 protocol spec from system_main while the user-message tail
 *     carries the v2 resolver/narrator spec — a hard contradiction that
 *     causes two-call mode to produce unparseable output.
 *
 * The version number is bumped here whenever the prompt's structural
 * contract changes incompatibly.
 */
export const SYSTEM_MAIN_CURRENT_VERSION = 2;

const VERSION_MARKER_RE = /<!--\s*@system-main-version:\s*(\d+)\s*-->/;

/**
 * Reads the `@system-main-version` marker. Treats absence as v1
 * (the pre-extraction baseline) so legacy custom profiles get the
 * intended fallback rather than being mistaken for current.
 */
export function getSystemMainVersion(content: string): number {
    if (!content) return 1;
    const m = content.match(VERSION_MARKER_RE);
    if (!m) return 1;
    const v = parseInt(m[1], 10);
    return Number.isFinite(v) ? v : 1;
}

export function isSystemMainCompatible(content: string): boolean {
    return getSystemMainVersion(content) >= SYSTEM_MAIN_CURRENT_VERSION;
}

/**
 * Strips the version marker (and the freeform v2 explanation comment that
 * sits next to it) before the system instruction is sent to the LLM —
 * this metadata is for the loader, not the model.
 */
export function stripSystemMainMarker(content: string): string {
    if (!content) return content;
    return content
        .replace(VERSION_MARKER_RE, '')
        .replace(/<!--\s*v2:[\s\S]*?-->\s*\n?/, '')
        .replace(/^\s*\n+/, '');
}
