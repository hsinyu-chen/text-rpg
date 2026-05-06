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

        const lines = content.split(/\r?\n/);
        // Trim whitespace-only lines from both ends — `^[\r\n]+` alone leaves
        // a leading "   \n" (whitespace + newline) in place because the regex
        // only matches CR/LF.
        while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
        while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();

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
        // Two-step parse: outer regex captures the attribute blob and body
        // separately, then attributes are extracted by name. Avoids baking
        // attribute order (file-then-context vs context-then-file) into the
        // outer pattern.
        const saveBlockRegex = /<save\s+([^>]*?)>([^]*?)<\/save>/gi;
        // Accept both quote styles — LLMs occasionally swap to single quotes.
        const fileAttrRegex = /\bfile=["']([^"']*)["']/i;
        const contextAttrRegex = /\bcontext=["']([^"']*)["']/i;
        const updateBlockRegex = /<update\s*>([^]*?)<\/update>/gi;
        const targetTagRegex = /<target\s*>([^]*?)<\/target>/i;
        const replacementTagRegex = /<replacement\s*>([^]*?)<\/replacement>/i;

        let saveMatch;
        while ((saveMatch = saveBlockRegex.exec(content)) !== null) {
            const attrs = saveMatch[1];
            const fileMatch = attrs.match(fileAttrRegex);
            if (!fileMatch) continue; // <save> without `file=` is malformed; skip silently.
            const filePath = fileMatch[1].trim().normalize('NFC');
            const contextMatch = attrs.match(contextAttrRegex);
            const context = (contextMatch?.[1] ?? '').trim().normalize('NFC');
            const saveContent = saveMatch[2];

            let updateMatch;
            updateBlockRegex.lastIndex = 0;
            let parsedInThisBlock = false;

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
                    parsedInThisBlock = true;
                }
            }

            // Fallback: <save> with bare <target>/<replacement> (no <update> wrapper).
            // Use a per-block flag rather than peeking `updates[-1].filePath`, which
            // would mis-skip the fallback when two consecutive <save> blocks target
            // the same file and the second has only bare tags.
            if (parsedInThisBlock) continue;

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
