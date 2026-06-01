import { describe, expect, it } from 'vitest';
import { extractFormatTemplate } from './extract-format-template.util';

describe('extractFormatTemplate', () => {
    it('returns empty string when no format section exists', () => {
        const content = ['# 核心人物', '## 露娜', '- 狀態:健康'].join('\n');
        expect(extractFormatTemplate(content)).toBe('');
    });

    it('extracts an L2 「格式」 section, bounded by the next same-level heading', () => {
        const content = [
            '# 核心人物',
            '## 存檔格式',
            '- 姓名:',
            '- 現況:',
            '## 露娜',
            '- 狀態:健康',
        ].join('\n');
        expect(extractFormatTemplate(content)).toBe(['## 存檔格式', '- 姓名:', '- 現況:'].join('\n'));
    });

    it('extracts an L1 「格式」 section bounded by the next L1', () => {
        const content = [
            '# 格式定義',
            '說明文字',
            '## 子節',
            '更多說明',
            '# 核心人物',
            '## 露娜',
        ].join('\n');
        expect(extractFormatTemplate(content)).toBe(
            ['# 格式定義', '說明文字', '## 子節', '更多說明'].join('\n'),
        );
    });

    it('matches the English word "format" case-insensitively', () => {
        const content = ['# Characters', '## Entry Format', '- name:', '## Luna', '- ok'].join('\n');
        expect(extractFormatTemplate(content)).toBe(['## Entry Format', '- name:'].join('\n'));
    });

    it('trims trailing blank lines from the section', () => {
        const content = ['## 格式', '- 範本', '', '', '## 露娜'].join('\n');
        expect(extractFormatTemplate(content)).toBe(['## 格式', '- 範本'].join('\n'));
    });

    it('returns the first matching section when more than one exists', () => {
        const content = ['## 格式 A', '- a', '## 格式 B', '- b'].join('\n');
        expect(extractFormatTemplate(content)).toBe(['## 格式 A', '- a'].join('\n'));
    });

    it('ignores a heading-like line inside a fenced code block', () => {
        const content = [
            '# 核心人物',
            '```',
            '# 格式 (這是程式碼,不是標題)',
            '```',
            '## 露娜',
        ].join('\n');
        expect(extractFormatTemplate(content)).toBe('');
    });

    it('runs to end of file when the format section is last', () => {
        const content = ['# 核心人物', '## 露娜', '- ok', '## 存檔格式', '- 範本'].join('\n');
        expect(extractFormatTemplate(content)).toBe(['## 存檔格式', '- 範本'].join('\n'));
    });
});
