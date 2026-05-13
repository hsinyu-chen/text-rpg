import { describe, expect, it } from 'vitest';
import {
  normalizeMessageLinks,
  unwrapAppUrlCode,
  backfillEmptyLabels,
  relabelUglyAppLinks,
  rewriteHallucinatedSchemes,
  dropInvalidMessageLinks,
  stripLeakedToolCallLinks,
  stripChatTemplateTokens,
  collapseAdjacentDuplicateLinks,
  applyHarnessFallbacks,
} from './normalize-message-links.util';

const G = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
const G2 = '11111111-2222-3333-4444-555555555555';
const ZH = { messageLink: '訊息連結' };
const EN = { messageLink: 'message link' };

describe('normalizeMessageLinks', () => {
  it('wraps a raw GUID with the i18n label on a 訊息-keyword line', () => {
    expect(normalizeMessageLinks(`目標訊息 ${G} 已找到`, ZH))
      .toBe(`目標訊息 [訊息連結](app://message/${G}) 已找到`);
  });

  it('uses the English label on a message-keyword line', () => {
    expect(normalizeMessageLinks(`Found Message ${G}.`, EN))
      .toBe(`Found Message [message link](app://message/${G}).`);
  });

  it('leaves GUIDs alone when neither keyword is on the line', () => {
    const text = `Book id ${G}`;
    expect(normalizeMessageLinks(text, EN)).toBe(text);
  });

  it('does not wrap a GUID that is the URL part of an existing link', () => {
    const text = `See message [前面那則](app://message/${G})`;
    expect(normalizeMessageLinks(text, ZH)).toBe(text);
  });

  it('handles multiple GUIDs on the same qualifying line', () => {
    expect(normalizeMessageLinks(`訊息 ${G} 與 ${G2} 衝突`, ZH))
      .toBe(`訊息 [訊息連結](app://message/${G}) 與 [訊息連結](app://message/${G2}) 衝突`);
  });

  it('returns empty string for non-string input', () => {
    expect(normalizeMessageLinks(undefined as unknown as string)).toBe('');
    expect(normalizeMessageLinks({} as unknown as string)).toBe('');
  });

  it('does NOT wrap a GUID that already lives inside a larger markdown-link label', () => {
    // Would otherwise produce nested invalid markdown:
    // `[See message [link](url) ref](url)`.
    const text = `[See message ${G} ref](app://message/${G})`;
    expect(normalizeMessageLinks(text, ZH)).toBe(text);
  });

  it('strips surrounding backticks from a bare GUID when wrapping', () => {
    // Otherwise the link ends up inside a code span → unclickable.
    expect(normalizeMessageLinks(`see message \`${G}\` for context`, EN))
      .toBe(`see message [message link](app://message/${G}) for context`);
  });

  it('skips GUIDs that are already part of any URL path', () => {
    const text = `see message [foo](app://file/${G})`;
    expect(normalizeMessageLinks(text, EN)).toBe(text);
  });
});

describe('unwrapAppUrlCode', () => {
  it('unwraps <code>-wrapped markdown links', () => {
    expect(unwrapAppUrlCode(`see <code>[訊息](app://message/${G})</code> here`, ZH))
      .toBe(`see [訊息](app://message/${G}) here`);
  });

  it('unwraps backtick-wrapped markdown links', () => {
    expect(unwrapAppUrlCode(`see \`[訊息](app://message/${G})\` here`, ZH))
      .toBe(`see [訊息](app://message/${G}) here`);
  });

  it('uses i18n message-link label for bare <code>-wrapped message URLs', () => {
    expect(unwrapAppUrlCode(`open <code>app://message/${G}</code> now`, ZH))
      .toBe(`open [訊息連結](app://message/${G}) now`);
  });

  it('uses the filename as label for bare app://file URLs', () => {
    expect(unwrapAppUrlCode('open `app://file/inventory.md` now', EN))
      .toBe('open [inventory.md](app://file/inventory.md) now');
  });

  it('falls back to the raw segment when filename has malformed percent-encoding', () => {
    // decodeURIComponent throws URIError on lone `%`. Hallucinated LLM URLs
    // hit this; the pipeline must not crash.
    expect(unwrapAppUrlCode('see `app://file/oops%.md` later', EN))
      .toBe('see [oops%.md](app://file/oops%.md) later');
  });

  it('strips <code> wrapping around a bare GUID (left for normalize to link)', () => {
    expect(unwrapAppUrlCode(`message <code>${G}</code> please`, EN))
      .toBe(`message ${G} please`);
  });

  it('uses the last segment as label for bare app://hint URLs', () => {
    expect(unwrapAppUrlCode('see `app://hint/chat-input/send` next', EN))
      .toBe('see [send](app://hint/chat-input/send) next');
  });

  it('is idempotent', () => {
    const once = unwrapAppUrlCode(`<code>[a](app://message/${G})</code>`, ZH);
    expect(unwrapAppUrlCode(once, ZH)).toBe(once);
  });

  it('returns empty string for non-string input', () => {
    expect(unwrapAppUrlCode(undefined as unknown as string)).toBe('');
    expect(unwrapAppUrlCode({} as unknown as string)).toBe('');
  });
});

describe('backfillEmptyLabels', () => {
  it('replaces empty-label message links with the i18n label', () => {
    expect(backfillEmptyLabels(`在 [](app://message/${G}) 中`, ZH))
      .toBe(`在 [訊息連結](app://message/${G}) 中`);
  });

  it('uses filename for empty-label file links', () => {
    expect(backfillEmptyLabels('open [](app://file/inventory.md) please', EN))
      .toBe('open [inventory.md](app://file/inventory.md) please');
  });

  it('leaves non-empty labels alone', () => {
    const text = `[訊息](app://message/${G})`;
    expect(backfillEmptyLabels(text, ZH)).toBe(text);
  });
});

describe('relabelUglyAppLinks', () => {
  it('replaces a GUID-as-label message link with the i18n label', () => {
    expect(relabelUglyAppLinks(`see [${G}](app://message/${G})`, ZH))
      .toBe(`see [訊息連結](app://message/${G})`);
  });

  it('replaces a full-URL-as-label app:// link with the URL-derived label', () => {
    expect(relabelUglyAppLinks('open [app://file/inventory.md](app://file/inventory.md)', EN))
      .toBe('open [inventory.md](app://file/inventory.md)');
  });

  it('leaves human-readable labels alone', () => {
    const text = `see [Luna 招募問答](app://message/${G})`;
    expect(relabelUglyAppLinks(text, ZH)).toBe(text);
  });

  it('handles a GUID label whose URL points to a different message id', () => {
    expect(relabelUglyAppLinks(`look at [${G}](app://message/${G2})`, EN))
      .toBe(`look at [message link](app://message/${G2})`);
  });

  it('relabels a fabricated https://-host label on an app:// URL', () => {
    // Small models sometimes emit `[https://app.com/message/<id>](app://message/<id>)`
    // — the visible label is a hallucinated HTTP URL that looks like the
    // real destination but isn't clickable as such.
    expect(relabelUglyAppLinks(`see [https://app.com/message/${G}](app://message/${G})`, ZH))
      .toBe(`see [訊息連結](app://message/${G})`);
  });

  it('relabels http://-host (non-tls) labels too', () => {
    expect(relabelUglyAppLinks(`open [http://example.local/file/x.md](app://file/inventory.md)`, EN))
      .toBe('open [inventory.md](app://file/inventory.md)');
  });
});

describe('rewriteHallucinatedSchemes', () => {
  it('rewrites app://chat/<GUID> to app://message/<GUID>', () => {
    expect(rewriteHallucinatedSchemes(`see [link](app://chat/${G})`))
      .toBe(`see [link](app://message/${G})`);
  });

  it('leaves app://hint/chat-input/... untouched (real hint path)', () => {
    const text = 'open [send](app://hint/chat-input/send)';
    expect(rewriteHallucinatedSchemes(text)).toBe(text);
  });

  it('leaves app://message/<GUID> untouched', () => {
    const text = `see [x](app://message/${G})`;
    expect(rewriteHallucinatedSchemes(text)).toBe(text);
  });

  it('returns empty string for non-string input', () => {
    expect(rewriteHallucinatedSchemes(undefined as unknown as string)).toBe('');
  });
});

describe('stripLeakedToolCallLinks', () => {
  it('strips a leaked submitResponse tool-call body, keeping the label', () => {
    // Real leak observed in production: model packs a native tool-call body
    // into the URL slot of a markdown link.
    const input = '我覺得[研究完成](submitResponse{message:"answer"}) 結束';
    expect(stripLeakedToolCallLinks(input)).toBe('我覺得研究完成 結束');
  });

  it('strips a leaked readTurnLogs body', () => {
    expect(stripLeakedToolCallLinks('see [link](readTurnLogs{kinds:["character"]})'))
      .toBe('see link');
  });

  it('does NOT strip a markdown link whose URL is a real app:// scheme', () => {
    const G = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
    const text = `see [the message](app://message/${G})`;
    expect(stripLeakedToolCallLinks(text)).toBe(text);
  });

  it('handles tool-call body whose args contain parentheses', () => {
    // Filenames with parens (`doc(v1).md`), regex sources with capture
    // groups, or any stringified arg value with `()` would terminate
    // a naive `[^)]*` body matcher early and leak a residual fragment.
    const input = 'try [edit](searchReplace{filename:"doc(v1).md",pattern:"(foo)"}) now';
    expect(stripLeakedToolCallLinks(input)).toBe('try edit now');
  });

  it('does NOT strip a link to an unknown function name (not a registered tool)', () => {
    // Safety net: limiting to KNOWN tool names prevents accidental
    // stripping of legitimate URLs that happen to start with `word{`.
    const text = 'see [doc](someUnknownFunc{x:1})';
    expect(stripLeakedToolCallLinks(text)).toBe(text);
  });

  it('returns empty string for non-string input', () => {
    expect(stripLeakedToolCallLinks(undefined as unknown as string)).toBe('');
  });
});

describe('stripChatTemplateTokens', () => {
  it('strips bare quote token <|"|> from prose', () => {
    expect(stripChatTemplateTokens('value: <|"|>hello<|"|> end'))
      .toBe('value: hello end');
  });

  it('strips tool-call envelope markers', () => {
    expect(stripChatTemplateTokens('text <|tool_call>name{}<tool_call|> more'))
      .toBe('text name{} more');
  });

  it('leaves regular angle-bracket prose alone', () => {
    const text = 'see <a href="x">link</a> in HTML';
    expect(stripChatTemplateTokens(text)).toBe(text);
  });

  it('returns empty string for non-string input', () => {
    expect(stripChatTemplateTokens(null as unknown as string)).toBe('');
  });
});

describe('dropInvalidMessageLinks', () => {
  it('strips a link whose id is a non-GUID word, keeping the label', () => {
    expect(dropInvalidMessageLinks('click [here](app://message/submitResponse)'))
      .toBe('click here');
  });

  it('keeps a valid app://message/<GUID> link', () => {
    const text = `see [label](app://message/${G})`;
    expect(dropInvalidMessageLinks(text)).toBe(text);
  });

  it('keeps valid id/action sub-paths (the GUID prefix passes)', () => {
    const text = `[edit](app://message/${G}/edit)`;
    expect(dropInvalidMessageLinks(text)).toBe(text);
  });

  it('returns empty string for non-string input', () => {
    expect(dropInvalidMessageLinks(null as unknown as string)).toBe('');
  });
});

describe('collapseAdjacentDuplicateLinks', () => {
  it('collapses two consecutive same-URL links into one', () => {
    expect(collapseAdjacentDuplicateLinks(`[](app://message/${G})[訊息連結](app://message/${G})`))
      .toBe(`[訊息連結](app://message/${G})`);
  });

  it('tolerates spaces between the two links', () => {
    expect(collapseAdjacentDuplicateLinks(`[a](app://message/${G})   [b](app://message/${G})`))
      .toBe(`[b](app://message/${G})`);
  });

  it('does NOT collapse across a newline', () => {
    const text = `[a](app://message/${G})\n[b](app://message/${G})`;
    expect(collapseAdjacentDuplicateLinks(text)).toBe(text);
  });

  it('does NOT collapse links to different URLs', () => {
    const text = `[a](app://message/${G})[b](app://message/${G2})`;
    expect(collapseAdjacentDuplicateLinks(text)).toBe(text);
  });

  it('collapses chains of 3+ duplicates', () => {
    const url = `app://message/${G}`;
    expect(collapseAdjacentDuplicateLinks(`[](${url})[訊息連結](${url})[訊息連結](${url})`))
      .toBe(`[訊息連結](${url})`);
  });
});

describe('URL with literal parentheses', () => {
  // URLs like `app://file/doc(v1).md` must not be cut off at the first `)`,
  // which would corrupt the surrounding text on every replace pass.
  it('collapseAdjacentDuplicateLinks handles URLs with balanced parens', () => {
    const url = 'app://file/doc(v1).md';
    expect(collapseAdjacentDuplicateLinks(`[a](${url})[b](${url})`))
      .toBe(`[b](${url})`);
  });

  it('unwrapAppUrlCode backtick-bare path preserves full URL including parens', () => {
    expect(unwrapAppUrlCode('see `app://file/doc(v1).md` later', EN))
      .toBe('see [doc(v1).md](app://file/doc(v1).md) later');
  });

  it('backfillEmptyLabels preserves full URL including parens', () => {
    expect(backfillEmptyLabels('open [](app://file/doc(v1).md) please', EN))
      .toBe('open [doc(v1).md](app://file/doc(v1).md) please');
  });
});

describe('applyHarnessFallbacks ordering invariants', () => {
  it('handles a leak whose URL slot has an envelope marker prefix in front of the toolname', () => {
    // Self-review-surfaced case: `[label](<|tool_call>submitResponse{...})`
    // — the model wrote the leaked tool-call body BUT also retained the
    // chat-template envelope opener as a literal. The link-scrubber must
    // run AFTER the token-strip step; otherwise the link-scrubber misses
    // (URL starts with `<|tool_call>`, not a known toolname), the
    // token-strip then removes the marker, and a naked
    // `[label](submitResponse{...})` would survive.
    const input = '研究[完成](<|tool_call>submitResponse{msg:"hello"}) 結束';
    expect(applyHarnessFallbacks(input)).toBe('研究完成 結束');
  });
});

describe('applyHarnessFallbacks (end-to-end)', () => {
  it('collapses the empty-label + backtick-bare-URL pattern into one labeled link', () => {
    // Repro for the user-reported case: model emits `[](url) \`url\`` and the
    // intermediate stages produce two adjacent links rendering as two <a>s.
    const url = `app://message/${G}`;
    expect(applyHarnessFallbacks(`在 [](${url}) \`${url}\` 訊息中`, ZH))
      .toBe(`在 [訊息連結](${url}) 訊息中`);
  });

  it('wraps a bare GUID and labels it', () => {
    expect(applyHarnessFallbacks(`See message ${G} for details`, EN))
      .toBe(`See message [message link](app://message/${G}) for details`);
  });

  it('handles code-wrapped + adjacent duplicate in one pass', () => {
    const url = `app://message/${G}`;
    expect(applyHarnessFallbacks(`<code>${url}</code>[](${url})`, ZH))
      .toBe(`[訊息連結](${url})`);
  });
});
