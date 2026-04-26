import { Injectable } from '@angular/core';
import { parse as parseJson } from 'best-effort-json-parser';
import { convertLatexToSymbols } from '../utils/latex.util';

@Injectable({
    providedIn: 'root'
})
export class ContentParserService {

    /**
     * Attempts to parse JSON from AI responses, even if incomplete or markdown-wrapped.
     * Uses 'best-effort-json-parser' for robustness.
     * @param text The raw text from the AI.
     * @returns The parsed object or null if failed.
     */
    bestEffortJsonParser(text: string): object {
        if (!text) return {};
        // Remove markdown code blocks if present
        let cleanText = text.trim();
        if (cleanText.startsWith('```json')) {
            cleanText = cleanText.replace(/^```json/, '').replace(/```$/, '');
        } else if (cleanText.startsWith('```')) {
            cleanText = cleanText.replace(/^```/, '').replace(/```$/, '');
        }

        try {
            return parseJson(cleanText);
        } catch (e) {
            console.warn('[ContentParser] JSON Parse Warning (Best Effort Failed):', e);
            return {};
        }
    }

    /**
     * Processes a string field from the model response.
     * Unescapes newlines and other characters.
     * @param text The raw string from the JSON.
     * @returns The processed string.
     */
    processModelField(text: string | undefined): string {
        if (!text) return '';
        
        let cleaned = text.trim();
        
        // Convert LaTeX symbols first while the backslashes are still intact
        cleaned = convertLatexToSymbols(cleaned);

        // Unescape standard JSON escapes that might have been double-escaped or raw
        return cleaned
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
}
