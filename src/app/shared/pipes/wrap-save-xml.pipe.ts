import { Pipe, PipeTransform } from '@angular/core';

/**
 * Wraps <save>...</save> XML blocks in markdown code fences
 * so they render as syntax-highlighted XML while the rest
 * of the content renders as normal markdown.
 */
@Pipe({
    name: 'wrapSaveXml',
    standalone: true
})
export class WrapSaveXmlPipe implements PipeTransform {
    transform(value: string | null | undefined): string {
        if (!value) return '';

        // Match all complete <save ...>...</save> blocks (including nested content)
        const completeBlockRegex = /(<save[\s][^>]*>[\s\S]*?<\/save>)/g;

        let result = value.replace(completeBlockRegex, (match) => {
            // Wrap the entire save block in xml code fence
            return '\n```xml\n' + match.trim() + '\n```\n';
        });

        // Match incomplete/streaming <save ... tags that haven't closed yet
        // This triggers when LLM outputs `<save file=` and onwards during streaming
        // Only match if not already inside a code fence (avoid double-wrapping)
        const incompleteBlockRegex = /(<save[\s][^>]*(?:>[\s\S]*)?)$/;
        const incompleteMatch = result.match(incompleteBlockRegex);

        if (incompleteMatch) {
            const matchedText = incompleteMatch[0];
            // Ensure it's not already wrapped in a code fence
            const beforeMatch = result.substring(0, incompleteMatch.index);
            if (!beforeMatch.endsWith('```xml\n') && !beforeMatch.endsWith('```xml\r\n')) {
                result = beforeMatch + '\n```xml\n' + matchedText.trim() + '\n```';
            }
        }

        // Clean up leading newline if content starts with code fence
        if (result.startsWith('\n```xml')) {
            result = result.substring(1);
        }

        return result;
    }
}
