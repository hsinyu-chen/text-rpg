import { describe, expect, it } from 'vitest';
import { writeStoryOutlineBlock } from './story-outline-handlers';

const FILE = '2.劇情綱要.md';
const HEADINGS = { STORY_OUTLINE_CHRONICLE: '劇情綱要' };
const CTX = { targetFile: FILE, fileContent: '', kbSectionHeadings: HEADINGS };

describe('writeStoryOutlineBlock', () => {
    it('returns empty for undefined / empty / whitespace-only input', () => {
        expect(writeStoryOutlineBlock(undefined, CTX)).toBe('');
        expect(writeStoryOutlineBlock('', CTX)).toBe('');
        expect(writeStoryOutlineBlock('   \n  \n', CTX)).toBe('');
    });

    it('emits an append <save> pinned to the chronicle L1 heading', () => {
        const xml = writeStoryOutlineBlock(
            '## Act.2 - 戰役\n\n- **戰況**：勝利',
            CTX,
        );
        expect(xml).toContain(`<save file="${FILE}" context="# 劇情綱要">`);
        expect(xml).toContain('<replacement>\n## Act.2 - 戰役\n\n- **戰況**：勝利</replacement>');
        expect(xml).not.toContain('<target>');
    });

    it('uses the locale-specific chronicle heading (en case)', () => {
        const xml = writeStoryOutlineBlock(
            '## Act.2 - The Battle',
            { ...CTX, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: 'Story Outline' } },
        );
        expect(xml).toContain('context="# Story Outline"');
    });

    it('returns empty if the locale has no chronicle heading configured', () => {
        // Defensive: an empty locale value would otherwise pin context to a
        // dangling `# ` and the FileUpdateParser would emit an unanchored
        // append. Treat as no-op instead.
        const xml = writeStoryOutlineBlock(
            '## Act.2',
            { ...CTX, kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: '' } },
        );
        expect(xml).toBe('');
    });

    it('trims the input but leaves the wrap-newlines intact', () => {
        const xml = writeStoryOutlineBlock(
            '   \n\n## Act.3\nbody\n\n   ',
            CTX,
        );
        expect(xml).toContain('<replacement>\n## Act.3\nbody</replacement>');
    });
});
