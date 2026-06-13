import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { DiskProfileSyncService } from './disk-profile-sync.service';
import { PromptRepository } from '../storage/prompt.repository';
import { IdbBootstrap } from '../storage/idb-bootstrap.service';
import { ProfileMetaRepository } from '../storage/profile-meta.repository';
import { InjectionService } from '../injection.service';
import { GameStateService } from '../game-state.service';
import { PromptProfileRegistryService } from '../prompt-profile-registry.service';
import { DiskProfileFolderService } from './disk-profile-folder.service';
import { readFileText, writeFileText } from './fsa-utils';

const HUNK = { filePath: 'system_main', targetContent: 'old', replacementContent: 'new' };
const PROFILE_ID = 'user_test1';

/** Minimal in-memory FileSystemDirectoryHandle for the FSA helpers under test. */
function makeFakeDir(name = 'root'): FileSystemDirectoryHandle {
  const files = new Map<string, string>();
  const dirs = new Map<string, FileSystemDirectoryHandle>();
  const handle = {
    name,
    async getDirectoryHandle(child: string, opts?: { create?: boolean }) {
      if (!dirs.has(child)) {
        if (!opts?.create) throw new DOMException('missing', 'NotFoundError');
        dirs.set(child, makeFakeDir(child));
      }
      return dirs.get(child)!;
    },
    async getFileHandle(file: string, opts?: { create?: boolean }) {
      if (!files.has(file)) {
        if (!opts?.create) throw new DOMException('missing', 'NotFoundError');
        files.set(file, '');
      }
      return {
        async getFile() { return { text: async () => files.get(file) ?? '' }; },
        async createWritable() {
          let buf = '';
          return {
            async write(chunk: string) { buf += chunk; },
            async close() { files.set(file, buf); },
          };
        },
      };
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

function makeFakeDb() {
  const store = new Map<string, unknown>();
  return {
    get: async (_s: string, key: string) => store.get(key),
    put: async (_s: string, val: unknown, key: string) => { store.set(key, val); },
  };
}

function makeHarness(profile: { id: string; isBuiltIn: boolean } = { id: PROFILE_ID, isBuiltIn: false }) {
  const root = makeFakeDir();
  let reloaded = 0;
  const injector = Injector.create({
    providers: [
      { provide: IdbBootstrap, useValue: { db: Promise.resolve(makeFakeDb()) } },
      PromptRepository,
      { provide: ProfileMetaRepository, useValue: { put: async () => undefined } },
      { provide: InjectionService, useValue: { forceReload: async () => { reloaded++; } } },
      { provide: GameStateService, useValue: { activePromptProfile: () => profile.id } },
      { provide: PromptProfileRegistryService, useValue: { get: () => ({ ...profile }), update: () => undefined } },
      { provide: DiskProfileFolderService, useValue: { ensurePermission: async () => root, handle: () => root, pickFolder: async () => undefined } },
      DiskProfileSyncService,
    ],
  });
  const service = runInInjectionContext(injector, () => new DiskProfileSyncService());
  const repo = injector.get(PromptRepository);
  return { service, repo, root, reloadCount: () => reloaded, id: profile.id };
}

async function profileDir(root: FileSystemDirectoryHandle, id = PROFILE_ID): Promise<FileSystemDirectoryHandle> {
  return root.getDirectoryHandle(id, { create: true });
}

const BUILTIN = { id: 'cloud', isBuiltIn: true };

describe('DiskProfileSyncService hunk sync', () => {
  describe('pushActiveToDisk', () => {
    it('writes the profile hunk set to hunks.json', async () => {
      const { service, repo, root } = makeHarness();
      await repo.saveProfileHunks('system_main', PROFILE_ID, [HUNK]);

      await service.pushActiveToDisk();

      const text = await readFileText(await profileDir(root), 'hunks.json');
      expect(JSON.parse(text!)).toEqual({ system_main: [HUNK] });
    });
  });

  describe('pullActiveFromDisk', () => {
    it('applies hunks from hunks.json and clears types the file omits (snapshot)', async () => {
      const { service, repo, root, reloadCount } = makeHarness();
      // Pre-existing hunk on a type absent from the incoming file — must be cleared.
      await repo.saveProfileHunks('action', PROFILE_ID, [HUNK]);
      await writeFileText(await profileDir(root), 'hunks.json', JSON.stringify({ system_main: [HUNK] }));

      await service.pullActiveFromDisk();

      expect(await repo.getProfileHunks('system_main', PROFILE_ID)).toEqual([HUNK]);
      expect(await repo.getProfileHunks('action', PROFILE_ID)).toEqual([]);
      expect(reloadCount()).toBe(1);
    });

    it('leaves IDB hunks untouched when hunks.json is absent', async () => {
      const { service, repo, root } = makeHarness();
      await repo.saveProfileHunks('action', PROFILE_ID, [HUNK]);
      // Create the profile dir without a hunks.json so the pull can find it.
      await writeFileText(await profileDir(root), 'profile.json', JSON.stringify({ version: 2, profile: { id: PROFILE_ID } }));

      await service.pullActiveFromDisk();

      expect(await repo.getProfileHunks('action', PROFILE_ID)).toEqual([HUNK]);
    });

    it('leaves IDB hunks untouched when hunks.json is malformed (literal null)', async () => {
      const { service, repo, root } = makeHarness();
      await repo.saveProfileHunks('action', PROFILE_ID, [HUNK]);
      await writeFileText(await profileDir(root), 'hunks.json', 'null');

      await service.pullActiveFromDisk();

      expect(await repo.getProfileHunks('action', PROFILE_ID)).toEqual([HUNK]);
    });

    it('skips a malformed per-type value instead of wiping the local hunk', async () => {
      const { service, repo, root } = makeHarness();
      await repo.saveProfileHunks('system_main', PROFILE_ID, [HUNK]);
      await writeFileText(await profileDir(root), 'hunks.json', JSON.stringify({ system_main: 'oops' }));

      await service.pullActiveFromDisk();

      expect(await repo.getProfileHunks('system_main', PROFILE_ID)).toEqual([HUNK]);
    });
  });

  describe('built-in profile (hunks-only)', () => {
    it('push writes only hunks.json — no envelope or base files', async () => {
      const { service, repo, root } = makeHarness(BUILTIN);
      await repo.saveProfileHunks('system_main', BUILTIN.id, [HUNK]);

      await service.pushActiveToDisk();

      const dir = await profileDir(root, BUILTIN.id);
      expect(JSON.parse((await readFileText(dir, 'hunks.json'))!)).toEqual({ system_main: [HUNK] });
      expect(await readFileText(dir, 'profile.json')).toBeNull();
      expect(await readFileText(dir, 'system_main.md')).toBeNull();
    });

    it('push throws when the built-in has no hunks', async () => {
      const { service } = makeHarness(BUILTIN);

      await expect(service.pushActiveToDisk()).rejects.toThrow();
    });

    it('pull applies only hunks, never base prompts, and counts restored types', async () => {
      const { service, repo, root } = makeHarness(BUILTIN);
      const dir = await profileDir(root, BUILTIN.id);
      await writeFileText(dir, 'hunks.json', JSON.stringify({ system_main: [HUNK] }));
      // A stray base file must be ignored — built-in base prompts are shipped assets.
      await writeFileText(dir, 'action.md', 'should be ignored');

      const result = await service.pullActiveFromDisk();

      expect(result).toEqual({ updatedTypes: 1, metaUpdated: false });
      expect(await repo.getProfileHunks('system_main', BUILTIN.id)).toEqual([HUNK]);
      expect(await repo.getProfilePrompt('action', BUILTIN.id)).toBeUndefined();
    });
  });
});
