import { describe, expect, it } from 'vitest';
import { FileUpdateParser } from './file-update-parser';

describe('FileUpdateParser', () => {
  describe('dedent', () => {
    it('returns empty for empty input', () => {
      expect(FileUpdateParser.dedent('')).toBe('');
    });

    it('strips common leading indent across all non-empty lines', () => {
      const input = '    line1\n    line2\n      indented';
      expect(FileUpdateParser.dedent(input)).toBe('line1\nline2\n  indented');
    });

    it('trims surrounding blank lines from XML-style wrapping', () => {
      const input = '\n\n  body\n  line\n\n  ';
      expect(FileUpdateParser.dedent(input)).toBe('body\nline');
    });

    it('treats blank lines as empty (no indent contribution)', () => {
      const input = '  a\n\n  b';
      expect(FileUpdateParser.dedent(input)).toBe('a\n\nb');
    });

    it('returns lines unchanged when minimum indent is 0', () => {
      const input = 'no indent\n  some indent';
      expect(FileUpdateParser.dedent(input)).toBe('no indent\n  some indent');
    });
  });

  describe('parse', () => {
    it('returns empty array when no save blocks present', () => {
      expect(FileUpdateParser.parse('plain text')).toEqual([]);
    });

    it('extracts a single update with target + replacement', () => {
      const input = `<save file="foo.md" context="# Top">
        <update>
          <target>old</target>
          <replacement>new</replacement>
        </update>
      </save>`;
      const result = FileUpdateParser.parse(input);
      expect(result).toEqual([{
        filePath: 'foo.md',
        context: '# Top',
        targetContent: 'old',
        replacementContent: 'new',
      }]);
    });

    it('handles multiple updates within one save block', () => {
      const input = `<save file="bar.md">
        <update><target>a</target><replacement>A</replacement></update>
        <update><target>b</target><replacement>B</replacement></update>
      </save>`;
      const result = FileUpdateParser.parse(input);
      expect(result.length).toBe(2);
      expect(result[0].targetContent).toBe('a');
      expect(result[1].targetContent).toBe('b');
    });

    it('falls back to bare <target>/<replacement> inside <save> when no <update> wrapper', () => {
      const input = `<save file="baz.md"><target>x</target><replacement>y</replacement></save>`;
      const result = FileUpdateParser.parse(input);
      expect(result).toEqual([{
        filePath: 'baz.md',
        context: '',
        targetContent: 'x',
        replacementContent: 'y',
      }]);
    });

    it('skips updates that have neither target nor replacement', () => {
      const input = `<save file="empty.md"><update></update></save>`;
      expect(FileUpdateParser.parse(input)).toEqual([]);
    });

    it('accepts attributes in either order (context before file)', () => {
      const input = `<save context="# Top" file="foo.md"><target>x</target></save>`;
      const result = FileUpdateParser.parse(input);
      expect(result).toEqual([{
        filePath: 'foo.md',
        context: '# Top',
        targetContent: 'x',
        replacementContent: undefined,
      }]);
    });

    it('skips a <save> block missing the file attribute', () => {
      const input = `<save context="# Top"><target>x</target></save>`;
      expect(FileUpdateParser.parse(input)).toEqual([]);
    });

    it('NFC-normalizes filePath and context', () => {
      // A combining-mark form vs precomposed; both should land on the same string.
      const decomposed = 'é'; // é precomposed
      const input = `<save file="${decomposed}.md" context="${decomposed}"><target>t</target></save>`;
      const result = FileUpdateParser.parse(input);
      expect(result[0].filePath).toBe(decomposed.normalize('NFC') + '.md');
      expect(result[0].context).toBe(decomposed.normalize('NFC'));
    });

    it('dedents target and replacement content', () => {
      const input = `<save file="f.md">
        <update>
          <target>
            indented target
          </target>
          <replacement>
            indented replacement
          </replacement>
        </update>
      </save>`;
      const result = FileUpdateParser.parse(input);
      expect(result[0].targetContent).toBe('indented target');
      expect(result[0].replacementContent).toBe('indented replacement');
    });

    it('does not skip fallback when previous save block targeted same file', () => {
      // Regression: peeking updates[-1].filePath would mis-skip the second
      // block's bare-tag fallback because the file matches.
      const input = `<save file="same.md"><update><target>a</target></update></save>
<save file="same.md"><target>b</target></save>`;
      const result = FileUpdateParser.parse(input);
      expect(result).toEqual([
        { filePath: 'same.md', context: '', targetContent: 'a', replacementContent: undefined },
        { filePath: 'same.md', context: '', targetContent: 'b', replacementContent: undefined },
      ]);
    });

    it('handles target-only (delete) and replacement-only (append) updates', () => {
      const input = `<save file="f.md">
        <update><target>delete me</target></update>
        <update><replacement>just append</replacement></update>
      </save>`;
      const result = FileUpdateParser.parse(input);
      expect(result[0].targetContent).toBe('delete me');
      expect(result[0].replacementContent).toBeUndefined();
      expect(result[1].targetContent).toBeUndefined();
      expect(result[1].replacementContent).toBe('just append');
    });
  });
});
