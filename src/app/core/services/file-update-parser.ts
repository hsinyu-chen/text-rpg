import { FileUpdate } from './file-update.types';

/**
 * Pure-logic parser for `<save>` / `<update>` LLM blocks.
 * No Angular DI; suitable for direct unit testing.
 */
export class FileUpdateParser {
    /**
     * Removes common leading whitespace from all lines in a block.
     * Also trims leading/trailing empty lines.
     */
    static dedent(content: string): string {
        if (!content) return '';

        const lines = content.replace(/^[\r\n]+/, '').replace(/[\r\n]+\s*$/, '').split(/\r?\n/);

        if (lines.length === 0) return '';

        let minIndent: number | null = null;
        for (const line of lines) {
            if (line.trim().length === 0) continue;
            const indentMatch = line.match(/^(\s*)/);
            const indentLen = indentMatch ? indentMatch[1].length : 0;
            if (minIndent === null || indentLen < minIndent) {
                minIndent = indentLen;
            }
        }

        if (minIndent === null || minIndent === 0) return lines.join('\n');

        return lines.map(line => {
            if (line.trim().length === 0) return '';
            return line.substring(minIndent!);
        }).join('\n');
    }

    /**
     * Parses LLM output to extract file updates using XML-like tags.
     * Format: `<save file="..." context="..."> <update> <target>...</target> <replacement>...</replacement> </update> </save>`
     */
    static parse(content: string): FileUpdate[] {
        const updates: FileUpdate[] = [];

        // [^]*? for non-greedy multi-line match across CR/LF.
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
            updateBlockRegex.lastIndex = 0;

            while ((updateMatch = updateBlockRegex.exec(saveContent)) !== null) {
                const updateContent = updateMatch[1];

                const targetMatch = updateContent.match(targetTagRegex);
                const replacementMatch = updateContent.match(replacementTagRegex);

                if (targetMatch || replacementMatch) {
                    updates.push({
                        filePath,
                        context,
                        targetContent: targetMatch ? this.dedent(targetMatch[1]) : undefined,
                        replacementContent: replacementMatch ? this.dedent(replacementMatch[1]) : undefined
                    });
                }
            }

            // Fallback: <save> with bare <target>/<replacement> (no <update> wrapper).
            if (updates.length > 0 && updates[updates.length - 1].filePath === filePath) continue;

            const targetDirect = saveContent.match(targetTagRegex);
            const replacementDirect = saveContent.match(replacementTagRegex);
            if (targetDirect || replacementDirect) {
                updates.push({
                    filePath,
                    context,
                    targetContent: targetDirect ? this.dedent(targetDirect[1]) : undefined,
                    replacementContent: replacementDirect ? this.dedent(replacementDirect[1]) : undefined
                });
            }
        }

        return updates;
    }
}
