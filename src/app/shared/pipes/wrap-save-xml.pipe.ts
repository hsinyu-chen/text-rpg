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

        // Match all <save ...>...</save> blocks (including nested content)
        // Using a non-greedy match for the content between tags
        const saveBlockRegex = /(<save\s[^>]*>[\s\S]*?<\/save>)/g;

        return value.replace(saveBlockRegex, (match) => {
            // Wrap the entire save block in xml code fence
            return '\n```xml\n' + match.trim() + '\n```\n';
        });
    }
}
