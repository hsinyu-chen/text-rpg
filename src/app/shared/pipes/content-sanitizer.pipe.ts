import { Pipe, PipeTransform } from '@angular/core';

/**
 * Unified content sanitizer pipe that strips various markers and tags from LLM output.
 * Consolidates multiple strip operations into one pipe for cleaner templates.
 *
 * Current operations:
 * - Strips <possible save point> tags
 * - Strips intent tags at start (e.g. <行動意圖>, <系統>, <存檔>, <繼續>)
 * - Strips fictional context disclaimer prefix (anti-guardrail measure)
 */
@Pipe({
    name: 'sanitize',
    standalone: true
})
export class ContentSanitizerPipe implements PipeTransform {
    // Fictional context disclaimer pattern (output by model, stripped before display)
    private static readonly FICTION_DISCLAIMER_PATTERN = /^<CREATIVE FICTION CONTEXT>\s*/i;

    // Save point marker pattern
    private static readonly SAVE_POINT_PATTERN = /<possible save point>/gi;

    // Intent tag pattern (matches tags like <行動意圖>, <system>, etc. at start)
    private static readonly INTENT_TAG_PATTERN = /^<[^>]+>/;

    transform(value: string | null | undefined, options?: SanitizeOptions): string {
        if (!value) return '';

        let result = value;

        // Strip fictional context disclaimer (always applied)
        result = result.replace(ContentSanitizerPipe.FICTION_DISCLAIMER_PATTERN, '');

        // Strip save point markers (always applied)
        result = result.replace(ContentSanitizerPipe.SAVE_POINT_PATTERN, '');

        // Strip intent tags (only if requested, for backward compatibility)
        if (options?.stripIntent) {
            result = result.replace(ContentSanitizerPipe.INTENT_TAG_PATTERN, '');
        }

        return result.trim();
    }
}

export interface SanitizeOptions {
    stripIntent?: boolean;
}
