import { describe, expect, it } from 'vitest';
import {
    SYSTEM_MAIN_CURRENT_VERSION,
    getSystemMainVersion,
    isSystemMainCompatible,
    stripSystemMainMarker
} from './profile-compat';

describe('getSystemMainVersion', () => {
    it('treats empty string as v1 (pre-extraction baseline)', () => {
        expect(getSystemMainVersion('')).toBe(1);
    });

    it('treats missing marker as v1', () => {
        expect(getSystemMainVersion('# Heading\n\nNo marker here.')).toBe(1);
    });

    it('parses an explicit v2 marker', () => {
        const content = '<!-- @system-main-version: 2 -->\n# Heading';
        expect(getSystemMainVersion(content)).toBe(2);
    });

    it('parses larger version numbers (forward-compatible)', () => {
        expect(getSystemMainVersion('<!-- @system-main-version: 7 -->')).toBe(7);
    });

    it('tolerates flexible whitespace inside the marker', () => {
        expect(getSystemMainVersion('<!--   @system-main-version:    3   -->')).toBe(3);
    });

    it('returns v1 when the version field is non-numeric', () => {
        expect(getSystemMainVersion('<!-- @system-main-version: abc -->')).toBe(1);
    });

    it('finds the marker even when it is not at the file start', () => {
        const content = 'preamble\n<!-- @system-main-version: 2 -->\n# Heading';
        expect(getSystemMainVersion(content)).toBe(2);
    });
});

describe('isSystemMainCompatible', () => {
    it('accepts content at the current version', () => {
        const atCurrent = `<!-- @system-main-version: ${SYSTEM_MAIN_CURRENT_VERSION} -->`;
        expect(isSystemMainCompatible(atCurrent)).toBe(true);
    });

    it('accepts content above the current version (forward-compatible)', () => {
        expect(isSystemMainCompatible('<!-- @system-main-version: 99 -->')).toBe(true);
    });

    it('rejects v1 (legacy fork)', () => {
        expect(isSystemMainCompatible('# Old heading without marker')).toBe(false);
    });

    it('rejects v2 (legacy fork after v3 bump for correction-resend)', () => {
        expect(isSystemMainCompatible('<!-- @system-main-version: 2 -->')).toBe(false);
    });

    it('rejects empty content', () => {
        expect(isSystemMainCompatible('')).toBe(false);
    });

    it('matches SYSTEM_MAIN_CURRENT_VERSION as the threshold', () => {
        const justBelow = `<!-- @system-main-version: ${SYSTEM_MAIN_CURRENT_VERSION - 1} -->`;
        const atCurrent = `<!-- @system-main-version: ${SYSTEM_MAIN_CURRENT_VERSION} -->`;
        expect(isSystemMainCompatible(justBelow)).toBe(false);
        expect(isSystemMainCompatible(atCurrent)).toBe(true);
    });
});

describe('stripSystemMainMarker', () => {
    it('removes the version marker line', () => {
        const content = '<!-- @system-main-version: 2 -->\n# Heading\nbody';
        expect(stripSystemMainMarker(content)).toBe('# Heading\nbody');
    });

    it('removes both the marker and the adjacent v2 explanation comment', () => {
        const content =
            '<!-- @system-main-version: 2 -->\n' +
            '<!-- v2: 輸出協議從本檔抽至 injection_protocol_*.md。請勿手動刪除此 marker。 -->\n\n' +
            '# 核心設定';
        expect(stripSystemMainMarker(content)).toBe('# 核心設定');
    });

    it('removes the en variant of the v2 comment', () => {
        const content =
            '<!-- @system-main-version: 2 -->\n' +
            '<!-- v2: output protocol extracted to injection_protocol_*.md. Do not delete this marker. -->\n\n' +
            '# Core Settings';
        expect(stripSystemMainMarker(content)).toBe('# Core Settings');
    });

    it('returns the input unchanged when no marker is present (legacy fork)', () => {
        const legacy = '# Old heading\nlegacy body';
        expect(stripSystemMainMarker(legacy)).toBe(legacy);
    });

    it('returns empty for empty input', () => {
        expect(stripSystemMainMarker('')).toBe('');
    });

    it('preserves the rest of the document (does not touch headings or content)', () => {
        const content =
            '<!-- @system-main-version: 2 -->\n\n' +
            '# Heading\n\n' +
            'Paragraph with <!-- inner comment --> survives.';
        const out = stripSystemMainMarker(content);
        expect(out).toContain('# Heading');
        expect(out).toContain('<!-- inner comment -->');
        expect(out).not.toContain('@system-main-version');
    });

    it('strips a leading vN: companion comment for future version bumps', () => {
        const content =
            '<!-- @system-main-version: 3 -->\n' +
            '<!-- v3: future bump should also be stripped -->\n\n' +
            '# Heading';
        expect(stripSystemMainMarker(content)).toBe('# Heading');
    });

    it('does NOT strip a body comment that happens to start with "v2:"', () => {
        const content =
            '<!-- @system-main-version: 2 -->\n' +
            '<!-- v2: leading companion gets stripped -->\n\n' +
            '# Heading\n\n' +
            'Paragraph: <!-- v2: this body comment must survive --> here.';
        const out = stripSystemMainMarker(content);
        expect(out).not.toContain('leading companion');
        expect(out).toContain('this body comment must survive');
    });
});
