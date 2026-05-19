/**
 * Scene-header extraction from a model message's `content` text.
 *
 * Two bracket conventions appear in story output and historically each
 * site (context-builder, multi-agent save's event extractor) carried its
 * own regex literal. Centralized here so a single spec covers the
 * matching rules and downstream sites can't drift.
 *
 *  - "Base header" — first `[…]` containing at least one ASCII digit.
 *    Typical example: `[Act.2 - 西街突襲]` or `[斷指冷鴉 — 12:42]`. Used
 *    in context-builder's summary-block prefix.
 *
 *  - "Time marker" — `[T …]` bracket carrying the in-fiction timestamp.
 *    Required when the base-header regex misses (e.g. pure CJK date
 *    like `[T 大宋 景德三年 三月初九]` has no ASCII digit and would
 *    otherwise leave the SceneEvent without a header at all).
 */

const SCENE_HEADER_RE = /\[\s*[^\]]*\d+[^\]]*\]/;
// Whitespace after `[T` is optional to match `TIME_MARKER_GLOBAL_RE` /
// legacy `context-builder.service.ts` — model output isn't guaranteed to
// put a space between `T` and the timestamp body.
const TIME_MARKER_GLOBAL_RE = /\[T\s*([^\]]+)\]/g;

/** First `[…]` bracket containing ASCII digit, or '' when absent. */
export function extractBaseSceneHeader(content: string | undefined): string {
  return content?.match(SCENE_HEADER_RE)?.[0] ?? '';
}

/**
 * Compact time-range marker from all `[T …]` brackets:
 *  - none → ''
 *  - one → that bracket verbatim
 *  - multiple → `[T <first inner>~T <last inner>]` (context-builder's
 *    summary-block convention)
 */
export function extractTimeMarkerRange(content: string | undefined): string {
  if (!content) return '';
  const matches = [...content.matchAll(TIME_MARKER_GLOBAL_RE)];
  if (matches.length === 0) return '';
  if (matches.length === 1) return matches[0][0];
  return `[T ${matches[0][1].trim()}~T ${matches[matches.length - 1][1].trim()}]`;
}

/**
 * Combined scene header for the per-message SceneEvent record:
 *  - base header + first `[T …]` joined by a space when both present
 *    and distinct
 *  - just the base header when it already contains the time marker
 *    (i.e. the base header IS a `[T …]` bracket that happens to carry an
 *    ASCII digit like `12:42` — would otherwise duplicate)
 *  - just the time marker when no separate base header exists
 *  - '' when neither matches
 *
 * The base-header regex misses pure-CJK timestamps, so the time marker
 * fallback is what keeps `sceneHeader` informative in dynastic-calendar
 * scenarios.
 */
export function extractSceneHeader(content: string | undefined): string {
  const base = extractBaseSceneHeader(content);
  if (!content) return base;
  // Use the range-aware helper so a single message with two `[T …]`
  // brackets (action start + end) gets the compacted `[T s~T e]` form,
  // matching the convention `context-builder.service.ts` uses for
  // summary-block prefixes.
  const time = extractTimeMarkerRange(content);
  if (!time) return base;
  if (!base) return time;
  // If the base header is itself a `[T …]` bracket (a single time
  // marker that happened to contain an ASCII digit like `12:42`),
  // the time range already covers it — return just the range form.
  // Otherwise base is a different header (e.g. `[Act.2 - …]`) and we
  // want both.
  if (base.startsWith('[T')) return time;
  return `${base} ${time}`;
}
