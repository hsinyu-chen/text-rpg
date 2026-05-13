import { Pipe, PipeTransform } from '@angular/core';

const SAVE_OPEN = '<save';
const SAVE_CLOSE = '</save>';

/**
 * Wraps every `<save ...>...</save>` block in a fenced ` ```xml ` code block so
 * ngx-markdown renders it as a syntax-highlighted code block instead of feeding
 * the raw `<save>` element to Angular's DomSanitizer (which would strip and
 * spam the console with `WARNING: sanitizing HTML stripped some content`).
 *
 * Streaming-safe: walks the string left-to-right and wraps each save block
 * independently. An open `<save ...>` without a matching `</save>` (the LLM
 * hasn't finished emitting yet) wraps from the opener through end-of-string —
 * including any trailing text the model may add between two save blocks while
 * the first is still in flight.
 *
 * The earlier regex-based version anchored the partial-match on `$`, which
 * caused trouble once a *complete* save block sat earlier in the buffer: the
 * greedy partial regex would re-match the already-wrapped opener, see its
 * preceding code fence, and skip — leaving any *later* partial `<save>` raw.
 */
@Pipe({ name: 'wrapSaveXml', standalone: true })
export class WrapSaveXmlPipe implements PipeTransform {
    transform(value: string | null | undefined): string {
        if (!value) return '';

        const out: string[] = [];
        let i = 0;
        const n = value.length;
        let wrappedAtStart = false;

        while (i < n) {
            const openIdx = value.indexOf(SAVE_OPEN, i);
            if (openIdx === -1) {
                out.push(value.slice(i));
                break;
            }
            // Distinguish `<save ...>` / `<save>` from unrelated tokens like
            // `<saved>` or `<savepoint>`. Required next-char is either the
            // closing `>` or whitespace before attributes.
            const nextChar = value.charAt(openIdx + SAVE_OPEN.length);
            const isSaveTag = nextChar === '>' || nextChar === ' ' || nextChar === '\t'
                || nextChar === '\n' || nextChar === '\r';
            if (!isSaveTag) {
                out.push(value.slice(i, openIdx + SAVE_OPEN.length));
                i = openIdx + SAVE_OPEN.length;
                continue;
            }

            // Emit pre-block text verbatim.
            out.push(value.slice(i, openIdx));

            const closeIdx = value.indexOf(SAVE_CLOSE, openIdx + SAVE_OPEN.length);
            const isComplete = closeIdx !== -1;
            const blockEnd = isComplete ? closeIdx + SAVE_CLOSE.length : n;
            const block = value.slice(openIdx, blockEnd).trim();
            if (out.length === 1 && out[0] === '') wrappedAtStart = true;
            out.push('\n```xml\n', block, '\n```');
            // Trailing newline for complete blocks so subsequent narration
            // doesn't run into the closing fence; partial blocks always end
            // at EOS so no separator needed.
            if (isComplete) out.push('\n');
            i = blockEnd;
        }

        let result = out.join('');
        // Strip the leading newline we added when the block was at position 0
        // so renderers that treat top-of-content specially don't see a stray
        // blank line.
        if (wrappedAtStart && result.startsWith('\n```xml')) {
            result = result.slice(1);
        }
        return result;
    }
}
