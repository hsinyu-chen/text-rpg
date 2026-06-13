import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { PromptCloudSyncService } from './prompt-cloud-sync.service';
import { PromptRepository } from '../storage/prompt.repository';
import { IdbBootstrap } from '../storage/idb-bootstrap.service';
import { ProfileMetaRepository } from '../storage/profile-meta.repository';
import { PromptProfileRegistryService } from '../prompt-profile-registry.service';
import { KVStore } from '../kv/kv-store';
import { SyncBackend } from './sync.types';

interface FakeProfile {
  id: string;
  isBuiltIn: boolean;
  displayName?: string;
  baseProfileId?: string;
  createdAt?: number;
  updatedAt?: number;
}

const HUNK = { filePath: 'system_main', targetContent: 'old', replacementContent: 'new' };

function makeFakeDb() {
  const store = new Map<string, unknown>();
  return {
    get: async (_s: string, key: string) => store.get(key),
    put: async (_s: string, val: unknown, key: string) => { store.set(key, val); },
  };
}

function makeRegistry(profiles: FakeProfile[]) {
  const map = new Map<string, FakeProfile>(profiles.map((p) => [p.id, p]));
  return {
    list: () => [...map.values()],
    get: (id: string) => map.get(id),
    add: (p: FakeProfile) => { map.set(p.id, p); },
    update: (id: string, patch: Partial<FakeProfile>) => {
      const e = map.get(id);
      if (e) map.set(id, { ...e, ...patch });
    },
  };
}

function makeBackend() {
  let stored: string | null = null;
  return {
    authenticate: async () => undefined,
    writePrompts: async (json: string) => { stored = json; },
    readPrompts: async () => stored,
    seed: (s: string) => { stored = s; },
    payload: () => (stored ? JSON.parse(stored) : null),
  };
}

function makeHarness(profiles: FakeProfile[]) {
  const injector = Injector.create({
    providers: [
      { provide: IdbBootstrap, useValue: { db: Promise.resolve(makeFakeDb()) } },
      PromptRepository,
      { provide: ProfileMetaRepository, useValue: { put: async () => undefined } },
      { provide: PromptProfileRegistryService, useValue: makeRegistry(profiles) },
      { provide: KVStore, useValue: { get: () => null, set: () => undefined } },
      PromptCloudSyncService,
    ],
  });
  const service = runInInjectionContext(injector, () => new PromptCloudSyncService());
  const repo = injector.get(PromptRepository);
  const backend = makeBackend();
  service.registerBackendResolver(async () => backend as unknown as SyncBackend);
  return { service, repo, backend };
}

const userProfile: FakeProfile = {
  id: 'user_test1', isBuiltIn: false, displayName: 'Test', baseProfileId: 'cloud', createdAt: 1, updatedAt: 2,
};

describe('PromptCloudSyncService hunk sync', () => {
  describe('uploadPrompts', () => {
    it('ships a user profile hunks keyed `${profileId}:${type}`', async () => {
      const { service, repo, backend } = makeHarness([userProfile]);
      await repo.saveProfilePrompt('system_main', 'user_test1', 'base');
      await repo.saveProfileHunks('system_main', 'user_test1', [HUNK]);

      await service.uploadPrompts();

      expect(backend.payload().hunks).toEqual({ 'user_test1:system_main': [HUNK] });
    });

    it('ships built-in hunks even when its base prompts are pristine', async () => {
      const { service, repo, backend } = makeHarness([{ id: 'cloud', isBuiltIn: true }]);
      // No base rows / no user-modified flag — only a local hunk overlay.
      await repo.saveProfileHunks('action', 'cloud', [HUNK]);

      await service.uploadPrompts();

      const payload = backend.payload();
      expect(payload.prompts).toEqual({});
      expect(payload.hunks).toEqual({ 'cloud:action': [HUNK] });
    });

    it('always emits the hunks field (empty) so a full deletion can sync', async () => {
      const { service, repo, backend } = makeHarness([userProfile]);
      await repo.saveProfilePrompt('system_main', 'user_test1', 'base');

      await service.uploadPrompts();

      expect(backend.payload().hunks).toEqual({});
    });
  });

  describe('downloadPrompts', () => {
    it('applies hunks for a registered profile', async () => {
      const { service, repo, backend } = makeHarness([userProfile]);
      backend.seed(JSON.stringify({
        version: 2,
        profiles: [userProfile],
        prompts: { 'user_test1:system_main': { content: 'base' } },
        hunks: { 'user_test1:system_main': [HUNK] },
      }));

      await service.downloadPrompts();

      expect(await repo.getProfileHunks('system_main', 'user_test1')).toEqual([HUNK]);
    });

    it('drops hunks whose profile never registers (orphan)', async () => {
      const { service, repo, backend } = makeHarness([{ id: 'cloud', isBuiltIn: true }]);
      backend.seed(JSON.stringify({
        version: 2,
        profiles: [],
        prompts: {},
        hunks: { 'user_ghost:system_main': [HUNK] },
      }));

      await service.downloadPrompts();

      expect(await repo.getProfileHunks('system_main', 'user_ghost')).toEqual([]);
    });

    it('imports a legacy v2 payload with no hunks field without error', async () => {
      const { service, repo, backend } = makeHarness([userProfile]);
      // A pre-feature payload (no hunks field) must not wipe existing local hunks.
      await repo.saveProfileHunks('action', 'cloud', [HUNK]);
      backend.seed(JSON.stringify({
        version: 2,
        profiles: [userProfile],
        prompts: { 'user_test1:system_main': { content: 'base' } },
      }));

      const { imported } = await service.downloadPrompts();

      expect(imported).toBe(1);
      expect(await repo.getProfileHunks('action', 'cloud')).toEqual([HUNK]);
    });

    it('tolerates a null hunks field without crashing or wiping local hunks', async () => {
      const { service, repo, backend } = makeHarness([userProfile]);
      await repo.saveProfileHunks('action', 'cloud', [HUNK]);
      backend.seed(JSON.stringify({
        version: 2,
        profiles: [userProfile],
        prompts: {},
        hunks: null,
      }));

      await service.downloadPrompts();

      expect(await repo.getProfileHunks('action', 'cloud')).toEqual([HUNK]);
    });

    it('clears hunks omitted from the payload — full cloud mirror', async () => {
      const { service, repo, backend } = makeHarness([userProfile]);
      // Local built-in hunk the cloud payload omits: download must clear it.
      await repo.saveProfileHunks('action', 'cloud', [HUNK]);
      backend.seed(JSON.stringify({
        version: 2,
        profiles: [userProfile],
        prompts: {},
        hunks: { 'user_test1:system_main': [HUNK] },
      }));

      await service.downloadPrompts();

      expect(await repo.getProfileHunks('action', 'cloud')).toEqual([]);
      expect(await repo.getProfileHunks('system_main', 'user_test1')).toEqual([HUNK]);
    });
  });

  describe('export / import single profile', () => {
    it('round-trips hunks to another device', async () => {
      const source = makeHarness([userProfile]);
      await source.repo.saveProfilePrompt('system_main', 'user_test1', 'base');
      await source.repo.saveProfileHunks('system_main', 'user_test1', [HUNK]);

      const json = await source.service.exportSingleProfile('user_test1');

      const dest = makeHarness([{ id: 'cloud', isBuiltIn: true }]);
      await dest.service.importSingleProfile(json);

      expect(await dest.repo.getProfileHunks('system_main', 'user_test1')).toEqual([HUNK]);
    });

    it('import is additive — it does not clear other profiles hunks', async () => {
      const dest = makeHarness([{ id: 'cloud', isBuiltIn: true }]);
      // A built-in hunk the imported file knows nothing about must survive.
      await dest.repo.saveProfileHunks('action', 'cloud', [HUNK]);
      const json = JSON.stringify({
        version: 2,
        profiles: [userProfile],
        prompts: { 'user_test1:system_main': { content: 'base' } },
        hunks: { 'user_test1:system_main': [HUNK] },
      });

      await dest.service.importSingleProfile(json);

      expect(await dest.repo.getProfileHunks('action', 'cloud')).toEqual([HUNK]);
      expect(await dest.repo.getProfileHunks('system_main', 'user_test1')).toEqual([HUNK]);
    });
  });
});
