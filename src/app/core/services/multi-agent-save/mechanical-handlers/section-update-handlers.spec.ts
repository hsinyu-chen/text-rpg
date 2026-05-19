import { describe, expect, it } from 'vitest';
import { applySectionUpdates } from './section-update-handlers';

const FILE = '5.科技裝備.md';
const CTX = { targetFile: FILE, fileContent: '', kbSectionHeadings: { STORY_OUTLINE_CHRONICLE: "" } };

describe('applySectionUpdates', () => {
    it('returns empty for empty input', () => {
        expect(applySectionUpdates([], CTX)).toBe('');
    });

    it('emits an append op when target is omitted', () => {
        const xml = applySectionUpdates([
            { sectionPath: '# 已開發武器 > ## 短弓改', replacement: '* **狀態**: 完工' },
        ], CTX);
        // `>` is NOT entity-escaped — see escapeAttr JSDoc. The downstream
        // parser splits on literal `>` to derive the heading breadcrumb.
        expect(xml).toContain(`<save file="${FILE}" context="# 已開發武器 > ## 短弓改">`);
        expect(xml).toContain('<replacement>* **狀態**: 完工</replacement>');
        expect(xml).not.toContain('<target>');
    });

    it('emits a replace op when target is provided', () => {
        const xml = applySectionUpdates([
            { sectionPath: '# 已開發武器 > ## 短弓改', target: '舊狀態', replacement: '新狀態' },
        ], CTX);
        expect(xml).toContain('<target>舊狀態</target>');
        expect(xml).toContain('<replacement>新狀態</replacement>');
    });

    it('groups multiple entries on the same sectionPath into one <save> block', () => {
        const xml = applySectionUpdates([
            { sectionPath: '# A > ## B', target: 'x', replacement: 'X' },
            { sectionPath: '# A > ## B', replacement: '* 附註' },
        ], CTX);
        expect(xml.match(/<save\b/g)).toHaveLength(1);
        expect(xml.match(/<update>/g)).toHaveLength(2);
    });

    it('emits separate <save> blocks for distinct sectionPaths', () => {
        const xml = applySectionUpdates([
            { sectionPath: '# A > ## B', replacement: 'x' },
            { sectionPath: '# C > ## D', replacement: 'y' },
        ], CTX);
        expect(xml.match(/<save\b/g)).toHaveLength(2);
    });

    it('preserves manifest insertion order across distinct sectionPaths', () => {
        // Ordering matters for trace readability — same as the manifest the LLM
        // emitted. The grouping pass uses a Map (insertion-ordered) to keep this
        // stable rather than alphabetizing.
        const xml = applySectionUpdates([
            { sectionPath: '# Z', replacement: 'z' },
            { sectionPath: '# A', replacement: 'a' },
        ], CTX);
        const zIdx = xml.indexOf('# Z');
        const aIdx = xml.indexOf('# A');
        expect(zIdx).toBeGreaterThan(-1);
        expect(aIdx).toBeGreaterThan(zIdx);
    });

    it('drops empty replacement on append (no point emitting a no-op)', () => {
        const xml = applySectionUpdates([
            { sectionPath: '# A', replacement: '' },
        ], CTX);
        expect(xml).toBe('');
    });

    it('drops degenerate empty target on replace (would match every position)', () => {
        const xml = applySectionUpdates([
            { sectionPath: '# A', target: '', replacement: 'x' },
        ], CTX);
        expect(xml).toBe('');
    });

    it('skips entries with no sectionPath rather than emitting a rootless block', () => {
        // SectionUpdate.sectionPath is required by the schema, but a buggy
        // model could still emit empty string — defend in handler too.
        const xml = applySectionUpdates([
            { sectionPath: '', replacement: 'x' },
        ], CTX);
        expect(xml).toBe('');
    });

    it('keeps the literal `>` in context attributes (NOT entity-encoded)', () => {
        // Critical for round-tripping: the FileUpdateParser does not decode
        // entities and MarkdownRangeMatcher splits the context on literal `>`
        // to derive the heading breadcrumb. Entity-encoding `>` would corrupt
        // the first segment as `# X &gt`.
        const xml = applySectionUpdates([
            { sectionPath: '# X > ## Y', replacement: 'z' },
        ], CTX);
        expect(xml).toContain('context="# X > ## Y"');
        expect(xml).not.toContain('&gt;');
    });
});
