/**
 * Schema-version compatibility for the active prompt profile's `system_main`.
 *
 * The shipped `system_prompt.md` carries an `@system-main-version` marker
 * as an HTML comment in the file's leading metadata block. The number is
 * bumped here whenever the system_main contract changes incompatibly with
 * the injection assets layered on top of it (intent injections / output
 * protocols). A custom profile whose stored `system_main` lacks the
 * current version is "legacy" — combining it with the current injection
 * stack produces duplicated or contradictory output-protocol specs.
 */
export const SYSTEM_MAIN_CURRENT_VERSION = 2;

const VERSION_MARKER_RE = /<!--\s*@system-main-version:\s*(\d+)\s*-->/;
// Companion explanation comment; only stripped when it sits in the leading
// metadata block at file start, so a body comment that happens to start
// with "vN:" is not silently removed. The version digits are generic so
// future bumps (v3, v4, ...) don't require touching this regex.
const LEADING_VERSION_COMMENT_RE = /^\s*<!--\s*v\d+:[\s\S]*?-->\s*\n?/;

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
 * Strips the version marker and its leading companion comment before
 * the system instruction is sent to the LLM — the metadata is for the
 * loader, not the model. The companion-comment regex is anchored to
 * file start so body comments are never touched.
 */
export function stripSystemMainMarker(content: string): string {
    if (!content) return content;
    return content
        .replace(VERSION_MARKER_RE, '')
        .replace(LEADING_VERSION_COMMENT_RE, '')
        .replace(/^\s*\n+/, '');
}
