import { Injectable, inject } from '@angular/core';
import { FileSystemService } from './file-system.service';
import { getCoreFilenames } from '../constants/engine-protocol';
import { LOCALES } from '../constants/locales';

export interface FileUpdate {
    filePath: string;
    targetContent?: string;
    replacementContent?: string;
    context?: string;
    line?: number;
    // Metadata for UI
    beforeLines?: string[];
    afterLines?: string[];
    matchIndex?: number;
    alreadyExists?: boolean;
    label?: string;
}

/**
 * Pure logic parser for file updates.
 * Independent of Angular ID to allow easy testing.
 */
export class FileUpdateParser {
    /**
     * Parses the LLM output to extract file updates using XML-like tags.
     * Format: <save file="..." context="..."> <update> <target>...</target> <replacement>...</replacement> </update> </save>
     */
    static parse(content: string): FileUpdate[] {
        const updates: FileUpdate[] = [];

        // Regex to find all <save> blocks
        // Using [^]*? for non-greedy multi-line match
        const saveBlockRegex = /<save\s+file="([^"]*)"(?:\s+context="([^"]*)")?\s*>([^]*?)<\/save>/gi;
        const updateBlockRegex = /<update\s*>([^]*?)<\/update>/gi;
        const targetTagRegex = /<target\s*>([^]*?)<\/target>/i;
        const replacementTagRegex = /<replacement\s*>([^]*?)<\/replacement>/i;

        let saveMatch;
        while ((saveMatch = saveBlockRegex.exec(content)) !== null) {
            const filePath = saveMatch[1].trim().normalize('NFC');
            const context = (saveMatch[2] || '').trim().normalize('NFC');
            const saveContent = saveMatch[3];

            let updateMatch;
            // Reset regex index for safety since it's used in a loop on different strings
            updateBlockRegex.lastIndex = 0;

            while ((updateMatch = updateBlockRegex.exec(saveContent)) !== null) {
                const updateContent = updateMatch[1];

                const targetMatch = updateContent.match(targetTagRegex);
                const replacementMatch = updateContent.match(replacementTagRegex);

                if (targetMatch || replacementMatch) {
                    updates.push({
                        filePath,
                        context,
                        targetContent: targetMatch ? targetMatch[1].trim() : undefined,
                        replacementContent: replacementMatch ? replacementMatch[1].trim() : undefined
                    });
                }
            }

            // Fallback: If there are no <update> blocks but there are <target> or <replacement> tags directly in <save>
            if (updates.length > 0 && updates[updates.length - 1].filePath === filePath) continue;

            const targetDirect = saveContent.match(targetTagRegex);
            const replacementDirect = saveContent.match(replacementTagRegex);
            if (targetDirect || replacementDirect) {
                updates.push({
                    filePath,
                    context,
                    targetContent: targetDirect ? targetDirect[1].trim() : undefined,
                    replacementContent: replacementDirect ? replacementDirect[1].trim() : undefined
                });
            }
        }

        return updates;
    }
}

@Injectable({
    providedIn: 'root'
})
export class FileUpdateService {
    private fileSystem = inject(FileSystemService);

    parser = FileUpdateParser;

    /**
     * Parses the LLM output to extract file updates using a state machine.
     * Supports various formats including standard headers, breadcrumbs, and inline markers.
     */
    parseUpdates(content: string): FileUpdate[] {
        return FileUpdateParser.parse(content);
    }

    /**
     * Generates a FileUpdate hunk for appending last_scene content.
     * @param storyContent The story content from the last action intent model response.
     * @param lang Language ID for determining the correct filename.
     * @returns A FileUpdate for appending to the Story Outline file.
     */
    generateLastSceneHunk(storyContent: string, lang = 'default'): FileUpdate {
        const names = getCoreFilenames(lang);
        // Strip <possible save point> tag from story content
        const cleanedContent = storyContent.replace(/<possible save point>/gi, '').trim();
        return {
            filePath: names.STORY_OUTLINE,
            context: '',
            replacementContent: '# last_scene\n\n' + cleanedContent,
            label: 'Auto-generated last_scene'
        };
    }

    /**
     * Preprocesses updates for a specific file, handling special cases like Story Outline last_scene.
     * For Story Outline:
     * 1. Insert a synthetic hunk at the start: target=old last_scene, replacement='' (deletes it)
     * 2. last_scene hunk: prepend header if missing (stays as APPEND)
     * Result: Old last_scene is deleted, Act summary appends, new last_scene appends with header
     */
    preprocessUpdates(updates: FileUpdate[], fileName: string, fileContent: string): FileUpdate[] {
        // Special handling for Story Outline file (check against all possible locale names)
        const isStoryOutline = Object.keys(LOCALES)
            .map(lang => getCoreFilenames(lang).STORY_OUTLINE)
            .some(name => fileName.includes(name.replace('.md', '')));

        if (!isStoryOutline || !fileContent) {
            return updates;
        }

        // Find where last_scene starts and extract everything from there to EOF
        const lastSceneRegex = /[#*_\s]*last[_-]?scene[#*_\s]*[:：]?/i;
        const match = fileContent.match(lastSceneRegex);
        if (!match || match.index === undefined) {
            return updates;
        }

        // Extract exact substring from file - no transformation
        const oldLastScene = fileContent.substring(match.index).trim();

        // Process existing updates: only ensure header on last_scene hunk
        const processedUpdates = updates.map(update => {
            const isLastSceneHunk = update.context && /last[_-]?scene/i.test(update.context);

            if (isLastSceneHunk) {
                // For last_scene hunk: only prepend header if missing, keep as APPEND
                const processed = { ...update };
                if (processed.replacementContent && !/^[#*_\s]*last[_-]?scene/im.test(processed.replacementContent)) {
                    processed.replacementContent = '# last_scene\n\n' + processed.replacementContent;
                }
                return processed;
            }

            return update;
        });

        // Insert synthetic hunk at the beginning to delete old last_scene
        const syntheticHunk: FileUpdate = {
            filePath: fileName,
            targetContent: oldLastScene,
            replacementContent: '',
            // Do NOT provide a context here, otherwise findContentMatch will fail 
            // because '[System]...' is not actually in the file text.
            context: undefined,
            label: 'Cleanup old last_scene'
        };

        return [syntheticHunk, ...processedUpdates];
    }


    /**
     * Apply a single update to content string.
     */
    public applyUpdateToFile(content: string, update: FileUpdate): string {
        if (update.targetContent) {
            // REPLACE/DELETE mode - use substring matching
            const range = this.findMatchRange(content, update.targetContent, update.context);

            if (range) {
                const before = content.substring(0, range.start);
                const after = content.substring(range.end);

                if (update.replacementContent) {
                    return before + update.replacementContent + after;
                } else {
                    // Just Delete
                    return before + after;
                }
            } else {
                console.warn(`Target content not found in ${update.filePath}`);
                return content; // No change
            }
        } else if (update.replacementContent) {
            // Pure ADD (Append) - still use line-based for section insertion
            const lines = content.split(/\r?\n/);
            const insertionIndex = this.findInsertionPoint(lines, update.context);

            // If context was provided but not found, don't modify the file
            if (insertionIndex === -1) {
                console.warn(`Context not found in ${update.filePath}: ${update.context}`);
                return content; // No change
            }

            const replacementLines = update.replacementContent.split(/\r?\n/);
            lines.splice(insertionIndex, 0, ...replacementLines);

            return lines.join('\n');
        }

        return content;
    }

    /**
     * Find substring match range with context verification.
     */
    public findMatchRange(content: string, target: string, context?: string): { start: number; end: number } | null {
        // Normalize both for comparison
        const normalizedContent = this.normalizeForComparison(content);
        const normalizedTarget = this.normalizeForComparison(target);

        if (!normalizedTarget) return null;

        let searchStart = 0;

        while (true) {
            // Find in normalized content
            const normalizedIndex = normalizedContent.indexOf(normalizedTarget, searchStart);
            if (normalizedIndex === -1) {
                break;
            }

            // Map strict bounds
            const start = this.mapNormalizedIndexToOriginal(content, normalizedIndex);
            const lastCharIndex = this.mapNormalizedIndexToOriginal(content, normalizedIndex + normalizedTarget.length - 1);
            const end = lastCharIndex + 1;

            if (context) {
                // Verify context by checking if target is under the expected section
                const lines = content.split(/\r?\n/);
                const lineIndex = this.getLineIndexFromCharIndex(content, start);
                if (this.verifyContext(lines, lineIndex, context)) {
                    return this.expandRange(content, target, start, end);
                } else {
                    searchStart = normalizedIndex + 1;
                    continue;
                }
            }

            return this.expandRange(content, target, start, end);
        }

        return null;
    }

    /**
     * Expand logic based on Target hints (e.g. eating hashes for loose header matching)
     */
    private expandRange(content: string, target: string, start: number, end: number): { start: number; end: number } {
        // Only expand if the target explicitly starts/ends with a hash (implying header intent)
        const expandLeft = target.startsWith('#');
        const expandRight = target.endsWith('#');

        let newStart = start;
        let newEnd = end;

        // Only expand over horizontal whitespace and hashes
        if (expandLeft) {
            while (newStart > 0 && /[#\t ]/.test(content[newStart - 1])) {
                newStart--;
            }
        }

        if (expandRight) {
            while (newEnd < content.length && /[#\t ]/.test(content[newEnd])) {
                newEnd++;
            }
        }

        return { start: newStart, end: newEnd };
    }

    async validateUpdate(update: FileUpdate): Promise<{
        exists: boolean,
        matched: boolean,
        alreadyExists?: boolean,
        beforeLines?: string[],
        afterLines?: string[],
        matchIndex?: number,
        failReason?: 'target_not_found' | 'context_mismatch'
    }> {
        try {
            const content = await this.fileSystem.readTextFile(update.filePath);
            const lines = content.split(/\r?\n/);
            const contextLinesCount = 5;

            if (update.targetContent) {
                // REPLACE/DELETE mode - use range matching
                const range = this.findMatchRange(content, update.targetContent, update.context);

                if (range) {
                    // Find line number for context display
                    const lineIndex = this.getLineIndexFromCharIndex(content, range.start);
                    const targetLineCount = update.targetContent.split(/\r?\n/).length;
                    const before = lines.slice(Math.max(0, lineIndex - contextLinesCount), lineIndex);
                    const afterStart = lineIndex + targetLineCount;
                    const after = lines.slice(afterStart, Math.min(lines.length, afterStart + contextLinesCount));

                    return {
                        exists: true,
                        matched: true,
                        matchIndex: range.start,
                        beforeLines: before,
                        afterLines: after
                    };
                }

                // Detailed failure reason fallback (could be improved by separate check)
                const existsWithoutContext = !!this.findMatchRange(content, update.targetContent);
                return {
                    exists: true,
                    matched: false,
                    failReason: existsWithoutContext ? 'context_mismatch' : 'target_not_found'
                };
            } else if (update.replacementContent) {
                // APPEND mode
                const insertionIndex = this.findInsertionPoint(lines, update.context);

                // If context was provided but not found, mark as failed
                if (insertionIndex === -1) {
                    return {
                        exists: true,
                        matched: false,
                        failReason: 'context_mismatch'
                    };
                }

                // Duplicate detection
                let alreadyExists = false;
                if (update.context) {
                    const normalizedFile = this.normalizeForComparison(content);
                    const normalizedReplacement = this.normalizeForComparison(update.replacementContent);
                    if (normalizedFile.includes(normalizedReplacement)) {
                        alreadyExists = true;
                    }
                }

                const before = lines.slice(Math.max(0, insertionIndex - contextLinesCount), insertionIndex);
                const after = lines.slice(insertionIndex, Math.min(lines.length, insertionIndex + contextLinesCount));

                return {
                    exists: true,
                    matched: true, // Appends always 'match' if section found
                    matchIndex: insertionIndex,
                    alreadyExists,
                    beforeLines: before,
                    afterLines: after
                };
            }

            return { exists: true, matched: true };
        } catch {
            return { exists: false, matched: false };
        }
    }

    private getLineIndexFromCharIndex(content: string, charIndex: number): number {
        const before = content.substring(0, charIndex);
        return before.split(/\r?\n/).length - 1;
    }

    async applyUpdates(updates: FileUpdate[]): Promise<string[]> {
        const results: string[] = [];

        // Group updates by file
        const updatesByFile = new Map<string, FileUpdate[]>();
        for (const update of updates) {
            if (!updatesByFile.has(update.filePath)) {
                updatesByFile.set(update.filePath, []);
            }
            updatesByFile.get(update.filePath)!.push(update);
        }

        for (const [file, fileUpdates] of updatesByFile) {
            try {
                // Read current file content
                let content = '';
                try {
                    content = await this.fileSystem.readTextFile(file);
                } catch {
                    console.warn(`File ${file} not found, creating new.`);
                }

                let newContent = content;

                for (const update of fileUpdates) {
                    newContent = this.applyUpdateToFile(newContent, update);
                }

                if (newContent !== content) {
                    await this.fileSystem.writeTextFile(file, newContent);
                    results.push(`Updated ${file}`);
                }
            } catch (err) {
                console.error(`Failed to update ${file}:`, err);
                results.push(`Error updating ${file}: ${err}`);
            }
        }

        return results;
    }

    public mapNormalizedIndexToOriginal(original: string, normalizedIndex: number): number {
        let normalizedCount = 0;
        for (let i = 0; i < original.length; i++) {
            const char = original[i];
            // Skip whitespace and hashes in counting (same as normalizeForComparison)
            if (!/[#\s]/.test(char)) {
                if (normalizedCount === normalizedIndex) {
                    return i;
                }
                normalizedCount++;
            }
        }
        return original.length;
    }

    private normalizeForComparison(line: string): string {
        if (!line) return '';
        return line
            .replace(/：/g, ':')
            .replace(/（/g, '(')
            .replace(/）/g, ')')
            .replace(/，/g, ',')
            .replace(/。/g, '.')
            .replace(/！/g, '!')
            .replace(/？/g, '?')
            .replace(/—/g, '-') // Em-dash to hyphen
            .replace(/[#\s]/g, ''); // Remove ALL whitespace and hashes (allow loose header matching)
    }

    public findInsertionPoint(lines: string[], context?: string): number {
        if (!context) return lines.length;

        const crumbs = context.split('>').map(c => c.trim());
        let currentLine = 0;
        let anyFound = false; // Track if at least one crumb was matched

        for (const crumb of crumbs) {
            let found = -1;

            // Check if crumb is a header (starts with #)
            const headerMatch = crumb.match(/^(#+)\s*(.*)/);
            const isStrictHeader = !!headerMatch;
            const crumbText = isStrictHeader ? headerMatch![2] : crumb;
            const normalizedCrumb = this.normalizeForComparison(crumbText);

            for (let i = currentLine; i < lines.length; i++) {
                const line = lines[i].trim();
                const lineHeaderMatch = line.match(/^(#+)\s*(.*)/);
                const isLineHeader = !!lineHeaderMatch;
                const lineText = isLineHeader ? lineHeaderMatch![2] : line;
                const normalizedLine = this.normalizeForComparison(lineText);

                if (normalizedLine.includes(normalizedCrumb)) {
                    if (isStrictHeader) {
                        // Strict Match: Must be a header, but ignore level (Allow # count mismatch)
                        if (isLineHeader) {
                            found = i;
                            anyFound = true;
                            break;
                        }
                    } else {
                        // Loose Match: Just needs to be a header or matches text
                        found = i;
                        anyFound = true;
                        break;
                    }
                }
            }

            if (found !== -1) {
                currentLine = found + 1;
            }
            // If not found, continue searching next crumb from the SAME currentLine (Skipped Layer)
        }

        // If context was provided but no crumb was matched, return -1 to indicate failure
        // This prevents inserting at file end when LLM gives a non-existent context
        if (!anyFound) return -1;

        // Find end of section: next header of <= current level
        const headerLine = lines[currentLine - 1];
        const headerLevelMatch = headerLine.match(/^(#+)/);
        const currentLevel = headerLevelMatch ? headerLevelMatch[1].length : 0;

        for (let i = currentLine; i < lines.length; i++) {
            const line = lines[i].trim();
            const nextHeaderMatch = line.match(/^(#+)/);
            if (nextHeaderMatch) {
                const nextLevel = nextHeaderMatch[1].length;
                if (nextLevel <= currentLevel) {
                    return i;
                }
            }
        }

        return lines.length;
    }

    private verifyContext(lines: string[], matchIndex: number, context: string): boolean {
        const crumbs = context.split('>').map(c => c.trim()).reverse();
        let currentIdx = matchIndex;
        let anyFound = false; // Track if at least one crumb was matched

        for (const crumb of crumbs) {
            let found = false;

            const headerMatch = crumb.match(/^(#+)\s*(.*)/);
            const isStrictHeader = !!headerMatch;
            const crumbText = isStrictHeader ? headerMatch![2] : crumb;
            const normalizedCrumb = this.normalizeForComparison(crumbText);

            for (let i = currentIdx - 1; i >= 0; i--) {
                const line = lines[i].trim();
                const lineHeaderMatch = line.match(/^(#+)\s*(.*)/);
                const isLineHeader = !!lineHeaderMatch;
                const lineText = isLineHeader ? lineHeaderMatch![2] : line;
                const normalizedLine = this.normalizeForComparison(lineText);

                if (normalizedLine.includes(normalizedCrumb)) {
                    if (isStrictHeader) {
                        // Relaxed: Just check if it's a header line, ignore level
                        if (isLineHeader) {
                            found = true;
                            anyFound = true;
                            currentIdx = i;
                            break;
                        }
                    } else {
                        found = true;
                        anyFound = true;
                        currentIdx = i;
                        break;
                    }
                }
            }
            if (!found) {
                // Allow Leaky Layers: If a crumb is not found, skip it and look for the next parent 
                // higher up in the file (continue loop without resetting currentIdx)
                continue;
            }
        }
        // Return true only if at least one crumb was matched
        // This prevents insertion at file end when context doesn't exist at all
        return anyFound;
    }
}
