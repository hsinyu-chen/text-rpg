import { Injectable, inject } from '@angular/core';
import { FileSystemService } from './file-system.service';
import { getCoreFilenames } from '../constants/engine-protocol';
import { LOCALES } from '../constants/locales';
import { FileUpdateParser } from './file-update-parser';
import {
    findContextLine as matcherFindContextLine,
    findInsertionPoint as matcherFindInsertionPoint,
    findMatchRange as matcherFindMatchRange,
    getLineIndexFromCharIndex,
    inferContextFromLine as matcherInferContextFromLine,
    normalizeForComparison,
} from './markdown-range-matcher';
import { FileUpdate } from './file-update.types';

export type { FileUpdate } from './file-update.types';

@Injectable({
    providedIn: 'root'
})
export class FileUpdateService {
    private fileSystem = inject(FileSystemService);

    parseUpdates(content: string): FileUpdate[] {
        return FileUpdateParser.parse(content);
    }

    /**
     * Generates a FileUpdate hunk for appending last_scene content.
     */
    generateLastSceneHunk(storyContent: string, lang = 'default'): FileUpdate {
        const names = getCoreFilenames(lang);
        const cleanedContent = storyContent
            .replace(/^(\[[^\]]*\]\s*)?<CREATIVE FICTION CONTEXT>\s*/i, '$1')
            .replace(/<possible save point>/gi, '')
            .trim();
        return {
            filePath: names.STORY_OUTLINE,
            context: '',
            replacementContent: '# last_scene\n\n' + cleanedContent,
            label: 'Auto-generated last_scene'
        };
    }

    /**
     * Story Outline special case: prepend a synthetic delete-old-last_scene
     * hunk and ensure the new last_scene hunk carries its `# last_scene`
     * header. Other files pass through untouched.
     */
    preprocessUpdates(updates: FileUpdate[], fileName: string, fileContent: string): FileUpdate[] {
        const isStoryOutline = Object.keys(LOCALES)
            .map(lang => getCoreFilenames(lang).STORY_OUTLINE)
            .some(name => fileName.includes(name.replace('.md', '')));

        if (!isStoryOutline || !fileContent) {
            return updates;
        }

        const lastSceneRegex = /[#*_\s]*last[_-]?scene[#*_\s]*[:：]?/i;
        const match = fileContent.match(lastSceneRegex);
        if (!match || match.index === undefined) {
            return updates;
        }

        const oldLastScene = fileContent.substring(match.index).trim();

        const processedUpdates = updates.map(update => {
            const isLastSceneHunk = update.context && /last[_-]?scene/i.test(update.context);

            if (isLastSceneHunk) {
                const processed = { ...update };
                if (processed.replacementContent && !/^[#*_\s]*last[_-]?scene/im.test(processed.replacementContent)) {
                    processed.replacementContent = '# last_scene\n\n' + processed.replacementContent;
                }
                return processed;
            }

            return update;
        });

        const syntheticHunk: FileUpdate = {
            filePath: fileName,
            targetContent: oldLastScene,
            replacementContent: '',
            // No context here: the leading `[System]…` framing isn't actually
            // in the file text, so context-verified matching would fail.
            context: undefined,
            label: 'Cleanup old last_scene'
        };

        return [syntheticHunk, ...processedUpdates];
    }

    public applyUpdateToFile(content: string, update: FileUpdate): string {
        if (update.targetContent) {
            const range = matcherFindMatchRange(content, update.targetContent, update.context);

            if (range) {
                const before = content.substring(0, range.start);
                const after = content.substring(range.end);

                if (update.replacementContent !== undefined) {
                    const replacement = update.replacementContent;

                    // Aware-vs-Lazy heuristic: if the LLM matched the file's
                    // indent in `target`, trust its replacement indentation;
                    // otherwise (lazy mode) re-indent the replacement to the
                    // file's column so it doesn't dangle at column 0 inside a
                    // nested block.
                    const targetIndent = update.targetContent?.match(/^([ \t]*)/)?.[1] || '';
                    const fileIndent = this.getIndentation(content, range.start);

                    const isAware = targetIndent.length > 0 && targetIndent === fileIndent;
                    const replacementIndent = replacement.match(/^([ \t]*)/)?.[1] || '';

                    if (!isAware && replacementIndent.length === 0 && fileIndent.length > 0) {
                        const reindented = replacement.split(/\r?\n/).map((line, idx) => {
                            if (idx === 0) return line;
                            return fileIndent + line;
                        }).join('\n');
                        return before + reindented + after;
                    }

                    return before + replacement + after;
                } else {
                    return before + after;
                }
            } else {
                console.warn(`Target content not found in ${update.filePath}`);
                return content;
            }
        } else if (update.replacementContent) {
            const lines = content.split(/\r?\n/);
            const insertionIndex = matcherFindInsertionPoint(lines, update.context);

            if (insertionIndex === -1) {
                console.warn(`Context not found in ${update.filePath}: ${update.context}`);
                return content;
            }

            const replacementLines = update.replacementContent.split(/\r?\n/);
            lines.splice(insertionIndex, 0, ...replacementLines);

            return lines.join('\n');
        }

        return content;
    }

    findMatchRange(content: string, target: string, context?: string): { start: number; end: number } | null {
        return matcherFindMatchRange(content, target, context);
    }

    findInsertionPoint(lines: string[], context?: string): number {
        return matcherFindInsertionPoint(lines, context);
    }

    findContextLine(content: string, context: string): number | null {
        return matcherFindContextLine(content, context);
    }

    inferContextFromLine(content: string, lineIndex: number): string {
        return matcherInferContextFromLine(content, lineIndex);
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
                const range = matcherFindMatchRange(content, update.targetContent, update.context);

                if (range) {
                    const lineIndex = getLineIndexFromCharIndex(content, range.start);
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

                const existsWithoutContext = !!matcherFindMatchRange(content, update.targetContent);
                return {
                    exists: true,
                    matched: false,
                    failReason: existsWithoutContext ? 'context_mismatch' : 'target_not_found'
                };
            } else if (update.replacementContent) {
                const insertionIndex = matcherFindInsertionPoint(lines, update.context);

                if (insertionIndex === -1) {
                    return {
                        exists: true,
                        matched: false,
                        failReason: 'context_mismatch'
                    };
                }

                let alreadyExists = false;
                if (update.context) {
                    if (normalizeForComparison(content).includes(normalizeForComparison(update.replacementContent))) {
                        alreadyExists = true;
                    }
                }

                const before = lines.slice(Math.max(0, insertionIndex - contextLinesCount), insertionIndex);
                const after = lines.slice(insertionIndex, Math.min(lines.length, insertionIndex + contextLinesCount));

                return {
                    exists: true,
                    matched: true,
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

    private getIndentation(content: string, index: number): string {
        let lineStart = index;
        while (lineStart > 0 && content[lineStart - 1] !== '\n' && content[lineStart - 1] !== '\r') {
            lineStart--;
        }
        const lineFragment = content.substring(lineStart, index);
        const match = lineFragment.match(/^([ \t]*)/);
        return match ? match[1] : '';
    }

    async applyUpdates(updates: FileUpdate[]): Promise<string[]> {
        const results: string[] = [];

        const updatesByFile = new Map<string, FileUpdate[]>();
        for (const update of updates) {
            if (!updatesByFile.has(update.filePath)) {
                updatesByFile.set(update.filePath, []);
            }
            updatesByFile.get(update.filePath)!.push(update);
        }

        for (const [file, fileUpdates] of updatesByFile) {
            try {
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
}
