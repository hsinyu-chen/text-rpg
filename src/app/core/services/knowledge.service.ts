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
     * Constructs the full Knowledge Base text from a file map, handling sorting and normalization.
     * @param files Map of file paths to content.
     * @returns The combined KB text string.
     */
    buildKnowledgeBaseText(files: Map<string, string>): string {
        let kbText = '';
        // Sort keys to ensure deterministic order regardless of insertion history
        const sortedKeys = Array.from(files.keys()).sort();

        sortedKeys.forEach(path => {
            if (!path.startsWith('system_files/') && path !== 'system_prompt.md') {
                let processedContent = files.get(path)!;
                // Strip last_scene from Story Outline
                const isStoryOutline = Object.values(LOCALES).some(l => l.coreFilenames.STORY_OUTLINE === path);

                if (isStoryOutline) {
                    const lastSceneRegex = /(?:^|\n)[#*_\s]*last[_-]?scene[#*_\s]*[:：]?[\s\S]*$/i;
                    processedContent = processedContent.replace(lastSceneRegex, '').trim();
                }
                kbText += `${LLM_MARKERS.FILE_CONTENT_SEPARATOR} [${path}] ---\n${processedContent}\n\n`;
            }
        });
        return kbText;
    }

    /**
     * Constructs the Part array for the Knowledge Base content from a file map.
     * @param files Map of file paths to content.
     * @returns Array of Part objects containing the file contents.
     */
    buildKnowledgeBaseParts(files: Map<string, string>): LLMPart[] {
        const text = this.buildKnowledgeBaseText(files);
        if (!text) return [];
        return [{ text }];
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
        const rawInput = (kbText || '') + (modelId || '') + (systemInstruction || '');
        return this.hashString(this.normalizeLineEndings(rawInput).trim());
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
