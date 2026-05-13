const GUID_RE = /(?<!app:\/\/message\/)(?<!\[)\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b(?!\]|\))/g;
const CONTEXT_RE = /訊息|message/i;

/**
 * Harness fallback for the file-agent: when the model emits a raw chat-message
 * GUID in user-visible text (submitResponse / reportProgress), wrap it in an
 * `app://message/<id>` markdown link so the user can still click through. Only
 * fires when the same line contains the word 訊息 / message — otherwise the
 * GUID is presumed unrelated. Skips GUIDs that already sit inside a markdown
 * link or after `app://message/`.
 */
export function normalizeMessageLinks(text: string): string {
  if (!text) return text;
  return text.split('\n').map(line => {
    if (!CONTEXT_RE.test(line)) return line;
    return line.replace(GUID_RE, guid => `[${guid}](app://message/${guid})`);
  }).join('\n');
}
