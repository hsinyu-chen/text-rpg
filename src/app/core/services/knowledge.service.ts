import { Injectable } from '@angular/core';
import { LLMPart } from './llm-provider';
import { LLM_MARKERS } from '../constants/engine-protocol';
import { LOCALES } from '../constants/locales';

/**
 * Service responsible for building and processing Knowledge Base content.
 * Handles KB text construction, hashing, and normalization.
 */
@Injectable({
    providedIn: 'root'
})
export class KnowledgeService {
    /**
     * Constructs the Part array for the Knowledge Base content from a file map.
     * @param files Map of file paths to content.
     * @returns Array of Part objects containing the file contents.
     */
    buildKnowledgeBaseParts(files: Map<string, string>): LLMPart[] {
        const parts: LLMPart[] = [];
        files.forEach((content, path) => {
            // Exclude system prompt from context injection as it's already in systemInstruction
            if (!path.startsWith('system_files/') && path !== 'system_prompt.md') {
                let processedContent = content;
                // Strip last_scene from Story Outline
                const isStoryOutline = Object.values(LOCALES).some(l => l.coreFilenames.STORY_OUTLINE === path);

                if (isStoryOutline) {
                    const lastSceneRegex = /(?:^|\n)[#*_\s]*last[_-]?scene[#*_\s]*[:：]?[\s\S]*$/i;
                    processedContent = content.replace(lastSceneRegex, '').trim();
                }
                parts.push({ text: `${LLM_MARKERS.FILE_CONTENT_SEPARATOR} [${path}] ---\\n${processedContent}\\n\\n` });
            }
        });
        return parts;
    }

    /**
     * Normalizes line endings to LF (\n) for consistent hashing across platforms.
     * @param str The input string.
     * @returns The normalized string.
     */
    normalizeLineEndings(str: string): string {
        return str.replace(/\r\n/g, '\n');
    }

    /**
     * Normalizes KB text and calculates a hash for cache reuse verification.
     * @param kbText The raw text of the knowledge base.
     * @param modelId The model ID to include in hash calculation.
     * @param systemInstruction The system instruction to include in hash calculation.
     * @returns A string hash.
     */
    calculateKbHash(kbText: string, modelId: string, systemInstruction: string): string {
        const rawInput = this.normalizeLineEndings(kbText) + (modelId || '') + (systemInstruction || '');
        return this.hashString(rawInput.trim());
    }

    /**
     * Generates a 32-bit integer string hash for a given string.
     * @param str The input string.
     * @returns The generated hash string.
     */
    hashString(str: string): string {
        let hash = 0;
        if (str.length === 0) return hash.toString();
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32bit integer
        }
        return hash.toString();
    }
}
