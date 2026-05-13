// crypto.randomUUID() output shape — every chat message id matches this.
const GUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

// URL body fragment: non-whitespace, non-paren chars OR a balanced single-level
// parenthesized run. Tolerates filenames like `doc(v1).md` while still
// terminating at the markdown link's closing `)`. `[^)\s]+` would cut off
// the URL at the FIRST `)`, corrupting any URL with literal parens.
const URL_INNER = '(?:[^\\s()]|\\([^\\s)]*\\))+';
const URL_PATTERN = `app:\\/\\/${URL_INNER}`;

// Matches a bare GUID, optionally wrapped in matching backticks (one each
// side). Backticks are consumed so the produced markdown link is not stuck
// inside a code span where markdown disables parsing.
const GUID_RE = new RegExp(`(?<!\\/)(?<!\\[)(\`?)\\b(${GUID_PATTERN})\\b\\1(?!\\])`, 'g');
const CONTEXT_RE = /訊息|message/i;

// Any well-formed markdown link — used to mask existing link spans so that
// pattern passes (e.g. bare-GUID wrapping) don't accidentally rewrite text
// that's already inside a link label or URL, which would produce nested /
// broken markdown. URL part is character-wise alternation between
// non-paren chars and a single balanced (...) pair; this shape avoids the
// catastrophic-backtracking risk of `[^)]*(?:\([^)]*\)[^)]*)*`.
const MARKDOWN_LINK_RE = /\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)/g;

const HTML_CODE_LINK_RE = new RegExp(`<code[^>]*>\\s*(\\[[^\\]]+\\]\\(${URL_PATTERN}\\))\\s*<\\/code>`, 'gi');
const HTML_CODE_BARE_RE = new RegExp(`<code[^>]*>\\s*(${URL_PATTERN})\\s*<\\/code>`, 'gi');
const HTML_CODE_GUID_RE = new RegExp(`<code[^>]*>\\s*(${GUID_PATTERN})\\s*<\\/code>`, 'gi');
const BACKTICK_LINK_RE  = new RegExp(`\`(\\[[^\\]]+\\]\\(${URL_PATTERN}\\))\``, 'g');
const BACKTICK_BARE_RE  = new RegExp(`\`(${URL_PATTERN})\``, 'g');

const EMPTY_LABEL_LINK_RE = new RegExp(`\\[\\]\\((${URL_PATTERN})\\)`, 'g');

// Markdown link to app://message/<id> whose LABEL is a bare GUID OR the URL
// itself. Both are visually meaningless — every chat message id is a UUID,
// so a GUID label is unreadable, and pasting the full URL as label defeats
// the point of a link. Replace with the locale-aware label.
const GUID_LABELED_MSG_RE = new RegExp(`\\[(${GUID_PATTERN})\\]\\((app:\\/\\/message\\/${URL_INNER})\\)`, 'g');
const URL_LABELED_APP_RE = new RegExp(`\\[(${URL_PATTERN})\\]\\((${URL_PATTERN})\\)`, 'g');
// `[https://anyhost/...](app://...)` — small models occasionally emit a
// fabricated HTTP URL as the visible label for a valid app:// link (e.g.
// "https://app.com/message/<id>" pasted as label). The URL is real but the
// label is a hallucination that looks like a clickable destination, which
// misleads users. Relabel via labelFor so the rendered text uses the
// locale-correct default (file name / message label / hint last-segment).
const HTTP_LABELED_APP_RE = new RegExp(`\\[(https?:\\/\\/[^\\]\\s]+)\\]\\((${URL_PATTERN})\\)`, 'g');
// `app://chat/<GUID>` — unambiguous hallucination of the canonical
// `app://message/<GUID>` scheme. No `chat` scheme is registered with
// agent-link-interceptor (only message / file / hint), and no real
// hint path starts with a bare GUID — every real `chat*` hint segment
// is `chat-input` / `chat-message` / `chat-config` under `app://hint/`,
// so anchoring the rewrite on the GUID shape rules out any collision.
const MISSPELLED_CHAT_SCHEME_RE = new RegExp(`app:\\/\\/chat\\/(${GUID_PATTERN})`, 'g');
// `[label](app://message/<non-GUID>)` — model invented an id that isn't
// a real chat-message GUID (e.g. tool names like "submitResponse",
// short slugs). The link is unclickable garbage; strip the URL and
// keep the label as plain text so prose still reads cleanly. Anchored
// on GUID NEGATION so legitimate id/<action> forms aren't touched —
// only links whose first segment is NOT a GUID.
const INVALID_MSG_ID_LINK_RE = new RegExp(
  `\\[([^\\]]*)\\]\\(app:\\/\\/message\\/(?!${GUID_PATTERN})${URL_INNER}\\)`,
  'g'
);

// Consecutive (only spaces/tabs between) markdown links to the SAME app:// URL.
const ADJ_DUP_RE = new RegExp(`\\[([^\\]]*)\\]\\((${URL_PATTERN})\\)[ \\t]*\\[([^\\]]*)\\]\\(\\2\\)`, 'g');

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
    const raw = url.slice('app://file/'.length).split('?')[0];
    // decodeURIComponent throws URIError on malformed escapes (lone `%`,
    // invalid sequence) — LLM output can produce these. Fall back to the
    // undecoded segment rather than crashing the whole pipeline.
    try { return decodeURIComponent(raw) || url; } catch { return raw || url; }
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

/**
 * Replace meaningless labels on `app://` links with locale-aware defaults:
 *   - `[<guid>](app://message/<id>)` — bare GUID as label is unreadable.
 *   - `[app://<scheme>/<...>](app://<...>)` — full URL as label defeats the
 *     point of a link, and clutters the rendered text.
 * The replacement is computed from the URL via `labelFor`, so message links
 * get the i18n label, file links get the filename, hint links get the last
 * segment.
 */
export function relabelUglyAppLinks(text: string, labels: HarnessLabels = DEFAULT_LABELS): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  return text
    .replace(GUID_LABELED_MSG_RE, (_, _guid: string, url: string) => `[${labelFor(url, labels)}](${url})`)
    .replace(URL_LABELED_APP_RE,  (_, _labelUrl: string, url: string) => `[${labelFor(url, labels)}](${url})`)
    .replace(HTTP_LABELED_APP_RE, (_, _labelUrl: string, url: string) => `[${labelFor(url, labels)}](${url})`);
}

/**
 * Rewrite known-misspelled `app://` schemes to their canonical form.
 * Small models sometimes emit `app://chat/<guid>` when they meant
 * `app://message/<guid>` — same id shape, different (non-registered)
 * scheme name. Run BEFORE any label-based rewrite so the rest of the
 * pipeline operates on canonical URLs.
 */
export function rewriteHallucinatedSchemes(text: string): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  return text.replace(MISSPELLED_CHAT_SCHEME_RE, 'app://message/$1');
}

/**
 * Strip `app://message/<non-GUID>` links — the model invented an id that
 * isn't a real chat-message UUID (e.g. a tool name like "submitResponse",
 * a short slug, an English word). Keep the label as plain text so prose
 * still reads cleanly; the broken click target is gone.
 */
export function dropInvalidMessageLinks(text: string): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  return text.replace(INVALID_MSG_ID_LINK_RE, '$1');
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
    // Tokenize: keep existing markdown links INTACT, run GUID_RE only on the
    // text outside them. Without this, a GUID appearing inside a larger
    // label like `[See message a1b2…ref](url)` would be wrapped in place,
    // producing nested / invalid markdown (`[See message [link](…) ref](url)`).
    let out = '';
    let cursor = 0;
    for (const m of line.matchAll(MARKDOWN_LINK_RE)) {
      const start = m.index ?? 0;
      out += line.slice(cursor, start).replace(GUID_RE, replaceGuid);
      out += m[0];
      cursor = start + m[0].length;
    }
    out += line.slice(cursor).replace(GUID_RE, replaceGuid);
    return out;

    function replaceGuid(_match: string, _quote: string, guid: string): string {
      return `[${labels.messageLink}](app://message/${guid})`;
    }
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
// Bound on collapse passes. Each pass halves a run-length of consecutive
// duplicate same-URL links, so 8 passes can fully collapse up to 2^8 = 256
// consecutive duplicates in a single line — far beyond anything a model
// would realistically emit. The bound exists to guarantee termination if a
// future regex change ever produces a fixed-point that's not a no-op.
const COLLAPSE_MAX_PASSES = 8;

export function collapseAdjacentDuplicateLinks(text: string): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  let prev = text;
  for (let i = 0; i < COLLAPSE_MAX_PASSES; i++) {
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
 *   1. Rewrite known-misspelled schemes (e.g. `app://chat/<guid>` →
 *      `app://message/<guid>`) — must run FIRST so every downstream
 *      step operates on canonical URLs.
 *   2. Unwrap code-span-wrapped `app://` URLs (and bare GUIDs in code).
 *   3. Backfill empty `[](url)` labels.
 *   4. Relabel ugly links — bare-GUID labels, full-URL-as-label, or
 *      hallucinated `[https://…](app://…)` labels.
 *   5. Drop links whose `app://message/<id>` carries a non-GUID id —
 *      the URL is unclickable; keep the label as plain prose.
 *   6. Wrap bare message GUIDs (with surrounding-backtick strip).
 *   7. Collapse consecutive duplicates that the previous steps may have
 *      produced when the model emitted overlapping forms (e.g. an empty
 *      stub followed by a backtick-wrapped bare URL pointing to the same
 *      message).
 */
export function applyHarnessFallbacks(text: string, labels: HarnessLabels = DEFAULT_LABELS): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  return collapseAdjacentDuplicateLinks(
    normalizeMessageLinks(
      dropInvalidMessageLinks(
        relabelUglyAppLinks(
          backfillEmptyLabels(
            unwrapAppUrlCode(rewriteHallucinatedSchemes(text), labels),
            labels,
          ),
          labels,
        ),
      ),
      labels,
    ),
  );
}
