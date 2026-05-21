import { describe, expect, it } from 'vitest';
import { writeStoryOutlineBlock } from './story-outline-handlers';

const FILE = '2.劇情綱要.md';
const HEADINGS = { STORY_OUTLINE_CHRONICLE: '劇情綱要' };
const CTX = { targetFile: FILE, fileContent: '', kbSectionHeadings: HEADINGS };

describe('writeStoryOutlineBlock', () => {
    it('returns empty array for undefined / empty / whitespace-only input', () => {
        expect(writeStoryOutlineBlock(undefined, CTX)).toEqual([]);
        expect(writeStoryOutlineBlock('', CTX)).toEqual([]);
        expect(writeStoryOutlineBlock('   \n  \n', CTX)).toEqual([]);
    });

    it('emits an append hunk pinned to the chronicle L1 heading', () => {
        const updates = writeStoryOutlineBlock(
            '## Act.2 - 戰役\n\n- **戰況**：勝利',
            CTX,
        );
        expect(updates).toEqual([
            {
                filePath: FILE,
                context: '# 劇情綱要',
                replacementContent: '\n## Act.2 - 戰役\n\n- **戰況**：勝利',
            },
        ]);
    });

    it('uses the locale-specific chronicle heading (en case)', () => {
        const updates = writeStoryOutlineBlock(
            '## Act.2 - The Battle',
            { ...CTX, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: 'Story Outline' } },
        );
        expect(updates[0].context).toBe('# Story Outline');
    });

    it('returns empty array if the locale has no chronicle heading configured', () => {
        // Defensive: an empty locale value would otherwise pin context to a
        // dangling `# ` and the matcher would emit an unanchored append.
        // Treat as no-op instead.
        const updates = writeStoryOutlineBlock(
            '## Act.2',
            { ...CTX, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: '' } },
        );
        expect(updates).toEqual([]);
    });

    it('trims the input but leaves the wrap-newline intact', () => {
        const updates = writeStoryOutlineBlock(
            '   \n\n## Act.3\nbody\n\n   ',
            CTX,
        );
        expect(updates[0].replacementContent).toBe('\n## Act.3\nbody');
    });
});
