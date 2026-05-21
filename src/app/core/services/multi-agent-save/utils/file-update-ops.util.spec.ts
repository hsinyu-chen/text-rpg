import { describe, expect, it } from 'vitest';
import { opsToFileUpdates } from './file-update-ops.util';

const FILE = 'kb.md';
const CTX = '# Section';

describe('opsToFileUpdates', () => {
    it('maps replace ops to FileUpdate hunks with target + replacement verbatim', () => {
        expect(opsToFileUpdates(FILE, CTX, [
            { kind: 'replace', target: 'old', replacement: 'new' },
        ])).toEqual([
            { filePath: FILE, context: CTX, targetContent: 'old', replacementContent: 'new' },
        ]);
    });

    it('maps delete ops to a replace hunk with empty replacement', () => {
        expect(opsToFileUpdates(FILE, CTX, [
            { kind: 'delete', target: 'gone' },
        ])).toEqual([
            { filePath: FILE, context: CTX, targetContent: 'gone', replacementContent: '' },
        ]);
    });

    it('maps append ops to a hunk with no targetContent', () => {
        const [u] = opsToFileUpdates(FILE, CTX, [
            { kind: 'append', replacement: '- item' },
        ]);
        expect(u).toEqual({ filePath: FILE, context: CTX, replacementContent: '- item' });
        expect(u.targetContent).toBeUndefined();
    });

    it('strips leading blank lines on append (mirrors legacy FileUpdateParser.dedent)', () => {
        // The append branch in FileUpdateService.applyUpdateToFile splits
        // the replacement on \r?\n and splices each element as its own line.
        // A handler-emitted leading `\n` would land as an extra blank line
        // in the file — historically dedent stripped it on the XML wire.
        expect(opsToFileUpdates(FILE, CTX, [
            { kind: 'append', replacement: '\n- item' },
        ])[0].replacementContent).toBe('- item');

        expect(opsToFileUpdates(FILE, CTX, [
            { kind: 'append', replacement: '\n\n## Block\n\nbody' },
        ])[0].replacementContent).toBe('## Block\n\nbody');
    });

    it('strips trailing blank lines on append (symmetry with leading strip)', () => {
        expect(opsToFileUpdates(FILE, CTX, [
            { kind: 'append', replacement: '- item\n\n' },
        ])[0].replacementContent).toBe('- item');
    });

    it('preserves common indent on append (different from full dedent)', () => {
        // applyUpdateToFile takes append content verbatim, so any indent the
        // handler emits must survive — only blank-line wrapping is stripped.
        expect(opsToFileUpdates(FILE, CTX, [
            { kind: 'append', replacement: '\n  - indented' },
        ])[0].replacementContent).toBe('  - indented');
    });

    it('does NOT strip leading blank lines on replace (`targetContent` path uses verbatim splice)', () => {
        // The replace branch in applyUpdateToFile does `before + replacement + after`
        // directly — no splice-into-lines — so a leading `\n` on the
        // replacement is part of the intended substitution and must survive.
        expect(opsToFileUpdates(FILE, CTX, [
            { kind: 'replace', target: 'old', replacement: '\nnew' },
        ])[0].replacementContent).toBe('\nnew');
    });
});
