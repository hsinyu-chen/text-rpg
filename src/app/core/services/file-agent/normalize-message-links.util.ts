const GUID_RE = /(?<!\/)(?<!\[)\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b(?!\])/g;
const CONTEXT_RE = /訊息|message/i;

// Per-URL unwrappers. The model is told NOT to wrap app:// links in backticks
// or <code>, but still does — anything inside a code span has markdown parsing
// disabled, so the link renders as literal text and is unclickable.
//
// Case A: markdown-link wrapped — `[label](app://...)` → unwrap, keep link
// Case B: bare URL wrapped     — `app://...`           → unwrap AND wrap as link (markdown auto-link doesn't fire on the `app://` scheme)
const HTML_CODE_LINK_RE  = /<code[^>]*>\s*(\[[^\]]+\]\(app:\/\/[^)\s]+\))\s*<\/code>/gi;
const HTML_CODE_BARE_RE  = /<code[^>]*>\s*(app:\/\/[^<\s]+?)\s*<\/code>/gi;
const BACKTICK_LINK_RE   = /`(\[[^\]]+\]\(app:\/\/[^)\s]+\))`/g;
const BACKTICK_BARE_RE   = /`(app:\/\/[^`\s]+)`/g;

/**
 * Harness fallback: strip `<code>` / backtick wrappers from individual
 * `app://...` URLs in the model output. Markdown disables link parsing
 * inside code spans, so a model that decorates a URL with backticks /
 * `<code>` produces an unclickable literal — defeating the whole point of
 * the deep-link system. Bare URLs get additionally wrapped as `[url](url)`
 * since markdown does not auto-link the `app://` scheme.
 *
 * Idempotent: re-running on already-unwrapped text is a no-op.
 */
export function unwrapAppUrlCode(text: string): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  return text
    .replace(HTML_CODE_LINK_RE, '$1')
    .replace(HTML_CODE_BARE_RE, (_, url: string) => `[${url}](${url})`)
    .replace(BACKTICK_LINK_RE,  '$1')
    .replace(BACKTICK_BARE_RE,  (_, url: string) => `[${url}](${url})`);
}

/**
 * Harness fallback for the file-agent: when the model emits a raw chat-message
 * GUID in user-visible text (submitResponse / reportProgress), wrap it in an
 * `app://message/<id>` markdown link so the user can still click through. Only
 * fires when the same line contains the word 訊息 / message — otherwise the
 * GUID is presumed unrelated. Skips GUIDs that already sit inside a markdown
 * link or after any URL path.
 */
export function normalizeMessageLinks(text: string): string {
  if (typeof text !== 'string') return '';
  if (!text) return text;
  return text.split('\n').map(line => {
    if (!CONTEXT_RE.test(line)) return line;
    return line.replace(GUID_RE, guid => `[${guid}](app://message/${guid})`);
  }).join('\n');
}
