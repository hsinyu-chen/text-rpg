import '@angular/compiler';
import { describe, expect, it, beforeEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { FileUpdateService } from './file-update.service';
import { FileSystemService } from './file-system.service';

// Sidesteps Angular's TestBed (which needs jsdom + initTestEnvironment that
// the project's vitest setup doesn't provide). The methods exercised below
// don't touch `this.fileSystem`, so a stub injector is sufficient.
function makeService(): FileUpdateService {
  const injector = Injector.create({
    providers: [{ provide: FileSystemService, useValue: {} }],
  });
  return runInInjectionContext(injector, () => new FileUpdateService());
}

describe('FileUpdateService', () => {
  let service: FileUpdateService;

  beforeEach(() => {
    service = makeService();
  });

  describe('findInsertionPoint', () => {
    it('returns lines.length when no context provided', () => {
      const lines = ['# A', 'body'];
      expect(service.findInsertionPoint(lines)).toBe(lines.length);
    });

    it('returns -1 when context is given but no crumb matches', () => {
      const lines = ['# Real', 'body'];
      expect(service.findInsertionPoint(lines, ['Missing'])).toBe(-1);
    });

    it('inserts at end of section when crumb matches header', () => {
      const lines = ['# A', 'body', '# B'];
      // section A spans line 0–1; insertion point is line 2 (next ≤-level header)
      expect(service.findInsertionPoint(lines, ['A'])).toBe(2);
    });

    it('walks a multi-level crumb path before computing boundary', () => {
      const lines = ['# Top', '## Sub', 'body', '### Deep', 'd', '# Other'];
      // Top > Sub lands on line 1, boundary scan stops at # Other (level 1 ≤ 2)
      expect(service.findInsertionPoint(lines, ['Top', 'Sub'])).toBe(5);
    });

    it('falls through to EOF when no terminating header follows', () => {
      const lines = ['# Top', 'a', 'b'];
      expect(service.findInsertionPoint(lines, ['Top'])).toBe(lines.length);
    });

    it('falls back to body-text crumbs (e.g. list items) and inserts right after the anchor', () => {
      const lines = ['# Real', '- 「foo」計畫', '# After'];
      expect(service.findInsertionPoint(lines, ['foo'])).toBe(2);
    });

    // Fence-awareness: the fix this spec was added for.
    // PR #13 made `findContextLine` / `verifyContext` / `inferContextFromLine`
    // skip fenced code blocks; `findInsertionPoint` was missed and would
    // happily land an anchor inside ```...```.
    describe('fence-awareness', () => {
      it('does NOT match a crumb whose only match is inside a fence', () => {
        const lines = [
          '# Real',
          'body',
          '```',
          '## fake',
          '```',
          '# After',
        ];
        expect(service.findInsertionPoint(lines, ['fake'])).toBe(-1);
      });

      it('boundary scan skips fenced fake-headings of equal level', () => {
        // # Top section's body wraps a fenced spec containing `# fake-equal-level`.
        // Without fence-awareness, the boundary scan would stop at the
        // fence and insertion lands inside the code block.
        const lines = [
          '# Top',
          'body',
          '```',
          '# fake-equal-level',
          '```',
          'more body',
          '# After',
        ];
        expect(service.findInsertionPoint(lines, ['Top'])).toBe(6);
      });

      it('still finds the real heading when both real and fenced fake exist', () => {
        const lines = [
          '# Real',
          '```',
          '## fake',
          '```',
          '## fake',
          'body',
          '# After',
        ];
        // `fake` skips line 2 (fenced), lands on line 4
        expect(service.findInsertionPoint(lines, ['fake'])).toBe(6);
      });
    });
  });

  describe('inferContextFromLine', () => {
    it('walks back through parent headings as raw heading-text crumbs', () => {
      const content = ['# Top', '## Sub', '### Deep', 'body line'].join('\n');
      expect(service.inferContextFromLine(content, 3)).toEqual(['Top', 'Sub', 'Deep']);
    });

    it('skips fenced fake-headings while walking back', () => {
      const content = [
        '# Real',
        '```',
        '## fake',
        '```',
        'body line',
      ].join('\n');
      expect(service.inferContextFromLine(content, 4)).toEqual(['Real']);
    });

    it('returns empty array when no heading exists above', () => {
      const content = ['plain', 'text', 'no headings'].join('\n');
      expect(service.inferContextFromLine(content, 2)).toEqual([]);
    });
  });

  describe('findContextLine', () => {
    it('returns the line index of the last crumb in the path', () => {
      const content = ['# Top', '## Sub', 'body'].join('\n');
      expect(service.findContextLine(content, ['Top', 'Sub'])).toBe(1);
    });

    it('does not match a crumb that lives inside a fenced block', () => {
      const content = ['# Real', '```', '## fake', '```'].join('\n');
      expect(service.findContextLine(content, ['fake'])).toBeNull();
    });

    it('returns null when no crumb matches anywhere', () => {
      const content = ['# Top', 'body'].join('\n');
      expect(service.findContextLine(content, ['Missing'])).toBeNull();
    });
  });
});
