import '@angular/compiler';
import { describe, expect, it, beforeEach } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { PromptHunkOverrideService } from './prompt-hunk-override.service';
import { FileUpdateService } from './file-update.service';
import { FileSystemService } from './file-system.service';
import { PromptRepository } from './storage/prompt.repository';
import { GameStateService } from './game-state.service';

// Real FileUpdateService (its matcher is pure — no FS hit in compose); the rest
// are stubs, since these tests exercise compose + validation aggregation only.
const promptBaseContent = signal<Map<string, string>>(new Map());
const hunkValidationError = signal<ReadonlySet<string>>(new Set());

function makeService(): PromptHunkOverrideService {
  const injector = Injector.create({
    providers: [
      { provide: FileSystemService, useValue: {} },
      FileUpdateService,
      { provide: PromptRepository, useValue: { getProfileHunks: async () => [], saveProfileHunks: async () => undefined } },
      { provide: GameStateService, useValue: { promptBaseContent, hunkValidationError } },
    ],
  });
  return runInInjectionContext(injector, () => new PromptHunkOverrideService());
}

describe('PromptHunkOverrideService', () => {
  let service: PromptHunkOverrideService;

  beforeEach(() => {
    promptBaseContent.set(new Map());
    hunkValidationError.set(new Set());
    service = makeService();
  });

  describe('compose', () => {
    it('applies a matched hunk to the base', () => {
      const base = ['# A', 'old', '# B'].join('\n');
      const r = service.compose(base, [{ filePath: 'x', targetContent: 'old', replacementContent: 'new' }]);
      expect(r.effective).toBe(['# A', 'new', '# B'].join('\n'));
      expect(r.anyFailed).toBe(false);
    });

    it('skips a hunk that no longer matches and flags anyFailed', () => {
      const base = ['# A', 'present'].join('\n');
      const r = service.compose(base, [{ filePath: 'x', targetContent: 'absent', replacementContent: 'x' }]);
      expect(r.effective).toBe(base);
      expect(r.anyFailed).toBe(true);
    });

    it('applies multiple hunks in order, each against the running result', () => {
      const base = ['one', 'two'].join('\n');
      const r = service.compose(base, [
        { filePath: 'x', targetContent: 'one', replacementContent: 'ONE' },
        { filePath: 'x', targetContent: 'two', replacementContent: 'TWO' },
      ]);
      expect(r.effective).toBe(['ONE', 'TWO'].join('\n'));
      expect(r.anyFailed).toBe(false);
    });
  });

  describe('refreshValidation', () => {
    it('marks a type whose hunk no longer matches its base', async () => {
      promptBaseContent.set(new Map([['system_main', 'present']]));
      await service.setHunks('system_main', 'cloud', [
        { filePath: 'system_main', targetContent: 'absent', replacementContent: 'x' },
      ]);
      service.refreshValidation();
      expect(hunkValidationError().has('system_main')).toBe(true);
    });

    it('leaves a type clear when all its hunks match', async () => {
      promptBaseContent.set(new Map([['system_main', 'present']]));
      await service.setHunks('system_main', 'cloud', [
        { filePath: 'system_main', targetContent: 'present', replacementContent: 'X' },
      ]);
      service.refreshValidation();
      expect(hunkValidationError().has('system_main')).toBe(false);
    });
  });
});
