// Matches a bare GUID, optionally wrapped in matching backticks (one each
// side). Backticks are consumed so the produced markdown link is not stuck
// inside a code span where markdown disables parsing.
const GUID_RE = /(?<!\/)(?<!\[)(`?)\b([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\b\1(?!\])/g;
const CONTEXT_RE = /訊息|message/i;

const HTML_CODE_LINK_RE = /<code[^>]*>\s*(\[[^\]]+\]\(app:\/\/[^)\s]+\))\s*<\/code>/gi;
const HTML_CODE_BARE_RE = /<code[^>]*>\s*(app:\/\/[^<\s]+?)\s*<\/code>/gi;
const HTML_CODE_GUID_RE = /<code[^>]*>\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*<\/code>/gi;
const BACKTICK_LINK_RE  = /`(\[[^\]]+\]\(app:\/\/[^)\s]+\))`/g;
const BACKTICK_BARE_RE  = /`(app:\/\/[^`\s]+)`/g;

const EMPTY_LABEL_LINK_RE = /\[\]\((app:\/\/[^)\s]+)\)/g;

// Consecutive (only spaces/tabs between) markdown links to the SAME app:// URL.
// Non-greedy URL capture so we match the shortest URL repeated in succession.
const ADJ_DUP_RE = /\[([^\]]*)\]\((app:\/\/[^)\s]+)\)[ \t]*\[([^\]]*)\]\(\2\)/g;

export interface HarnessLabels {
  /** Label used when the harness emits or backfills a link pointing at
   * `app://message/<id>` — defaults to the English "message link" but the
   * service passes the locale-correct copy through i18n. */
  messageLink: string;
}

const DEFAULT_LABELS: HarnessLabels = { messageLink: 'message link' };

/** Derive a sensible default label for an `app://` URL. */
function labelFor(url: string, labels: HarnessLabels): string {
  if (url.startsWith('app://message/')) return labels.messageLink;
  if (url.startsWith('app://file/')) {
    return decodeURIComponent(url.slice('app://file/'.length).split('?')[0]) || url;
  }
  if (url.startsWith('app://hint/')) {
    const path = url.slice('app://hint/'.length).split('?')[0];
    const last = path.split('/').filter(Boolean).pop();
    return last ?? url;
  }
  return url;
}

/**
 * Strip `<code>` / backtick wrappers around `app://...` URLs (markdown
 * suppresses link parsing inside code spans, so wrapped URLs render as
 * unclickable literal text). Bare URLs in code get wrapped as
 * `[label](url)` since markdown does not auto-link the `app://` scheme.
 *
 * Idempotent.
 */
export function unwrapAppUrlCode(text: string, labels: HarnessLabels = DEFAULT_LABELS): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  return text
    .replace(HTML_CODE_LINK_RE, '$1')
    .replace(HTML_CODE_BARE_RE, (_, url: string) => `[${labelFor(url, labels)}](${url})`)
    .replace(HTML_CODE_GUID_RE, '$1')
    .replace(BACKTICK_LINK_RE,  '$1')
    .replace(BACKTICK_BARE_RE,  (_, url: string) => `[${labelFor(url, labels)}](${url})`);
}

/** Replace `[](app://...)` empty-label links with a locale-appropriate label. */
export function backfillEmptyLabels(text: string, labels: HarnessLabels = DEFAULT_LABELS): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  return text.replace(EMPTY_LABEL_LINK_RE, (_, url: string) => `[${labelFor(url, labels)}](${url})`);
}

/**
 * Wrap raw chat-message GUIDs in `app://message/<id>` links when the same
 * line mentions 訊息 / message — defensive net for the model emitting bare
 * IDs. Skips GUIDs already inside a markdown link or any URL path.
 */
export function normalizeMessageLinks(text: string, labels: HarnessLabels = DEFAULT_LABELS): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  return text.split('\n').map(line => {
    if (!CONTEXT_RE.test(line)) return line;
    // Capture group 1 is the optional backtick; group 2 is the GUID itself.
    // Discarding the backticks frees the link from the code span.
    return line.replace(GUID_RE, (_, _quote, guid) => `[${labels.messageLink}](app://message/${guid})`);
  }).join('\n');
}

/**
 * Collapse two CONSECUTIVE markdown links to the same `app://` URL into
 * one. Tolerates only spaces/tabs between (no newlines), so a deliberate
 * mention on a later line stays intact. Prefers the non-empty label; if
 * both labels are non-empty and distinct, the second wins (typically the
 * harness's own label-fill replaces the model's empty stub). Loops until
 * stable so triple+ duplicates collapse fully.
 */
export function collapseAdjacentDuplicateLinks(text: string): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  let prev = text;
  for (let i = 0; i < 8; i++) {
    const next = prev.replace(ADJ_DUP_RE, (_, l1: string, url: string, l2: string) => {
      const label = (l2.trim() || l1.trim() || url);
      return `[${label}](${url})`;
    });
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

/**
 * Single entry point for the file-agent service. Applies all harness
 * fallbacks in the right order:
 *   1. Unwrap code-span-wrapped `app://` URLs.
 *   2. Backfill empty `[](url)` labels.
 *   3. Wrap bare message GUIDs.
 *   4. Collapse consecutive duplicates that the previous steps may have
 *      produced when the model emitted overlapping forms (e.g. an empty
 *      stub followed by a backtick-wrapped bare URL pointing to the same
 *      message).
 */
export function applyHarnessFallbacks(text: string, labels: HarnessLabels = DEFAULT_LABELS): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  return collapseAdjacentDuplicateLinks(
    normalizeMessageLinks(
      backfillEmptyLabels(
        unwrapAppUrlCode(text, labels),
        labels,
      ),
      labels,
    ),
  );
}
