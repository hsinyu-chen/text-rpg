import { describe, it, expect, vi, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { FileAgentService } from './file-agent.service';
import { FileAgentSettingsStore, FILE_AGENT_PROFILE_KEY } from './file-agent-settings.store';
import { KVStore } from '../kv/kv-store';
import { InMemoryKVStore } from '../../testing/in-memory-kv-store';
import { LLMConfigService } from '../llm-config.service';
import { LLMProviderRegistryService } from '../llm-provider-registry.service';
import { BookRepository } from '../storage/book.repository';
import { CollectionService } from '../collection.service';
import { SessionService } from '../session.service';

function setup(opts: {
  kvSeed?: Record<string, string>;
  mainChatActive?: string | null;
  profiles?: { id: string; provider: string; settings: Record<string, unknown> }[];
  providerCaps?: { supportsNativeToolCalls?: boolean };
  probeNativeToolSupport?: (settings: unknown) => Promise<boolean>;
} = {}): {
  svc: FileAgentService;
  kv: InMemoryKVStore;
} {
  TestBed.resetTestingModule();
  const kv = new InMemoryKVStore(opts.kvSeed);
  const llmConfigMock = {
    profiles: signal(opts.profiles ?? []),
    activeProfileId: signal(opts.mainChatActive ?? null)
  };
  const registryMock = {
    getProvider: () => ({
      getCapabilities: () => ({ supportsNativeToolCalls: !!opts.providerCaps?.supportsNativeToolCalls }),
      probeNativeToolSupport: opts.probeNativeToolSupport,
      probeParallelToolSupport: undefined
    })
  };
  // BookRepository / CollectionService / SessionService are only touched by
  // runAgent's snapshotBooks/Collections — these profile-persistence tests
  // never invoke runAgent, so stub them out to keep the IndexedDB-backed
  // repo from being instantiated under jsdom (no `indexedDB`).
  const bookRepoStub = { list: () => Promise.resolve([]) };
  const collectionsStub = { collections: signal([]), load: () => Promise.resolve() };
  const sessionStub = { currentBookId: () => null };
  TestBed.configureTestingModule({
    providers: [
      FileAgentService,
      { provide: KVStore, useValue: kv },
      { provide: LLMConfigService, useValue: llmConfigMock },
      { provide: LLMProviderRegistryService, useValue: registryMock },
      { provide: BookRepository, useValue: bookRepoStub },
      { provide: CollectionService, useValue: collectionsStub },
      { provide: SessionService, useValue: sessionStub }
    ]
  });
  return { svc: TestBed.inject(FileAgentService), kv };
}

describe('FileAgentService — profile persistence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses KV-stored profile id when present, ignoring main-chat active', () => {
    const { svc } = setup({
      kvSeed: { [FILE_AGENT_PROFILE_KEY]: 'p-kv' },
      mainChatActive: 'p-main'
    });
    expect(svc.selectedProfileId()).toBe('p-kv');
  });

  it('falls back to main-chat active profile when KV has no file-agent choice yet', () => {
    const { svc } = setup({ mainChatActive: 'p-main' });
    expect(svc.selectedProfileId()).toBe('p-main');
  });

  it('falls back to null when both KV and main-chat are empty', () => {
    const { svc } = setup();
    expect(svc.selectedProfileId()).toBeNull();
  });

  it('selectProfile() persists the new id to KV', () => {
    const { svc, kv } = setup({ mainChatActive: 'p-main' });
    svc.selectProfile('p-new');
    expect(svc.selectedProfileId()).toBe('p-new');
    expect(kv.get(FILE_AGENT_PROFILE_KEY)).toBe('p-new');
  });

  it('shares the selectedProfileId signal across instances via FileAgentSettingsStore', () => {
    // Same TestBed → same root injector → same FileAgentSettingsStore singleton.
    // Both FileAgentService instances must observe the SAME signal value when
    // either one calls selectProfile, not a per-instance cached copy.
    const { svc: first } = setup({ mainChatActive: 'p-main' });
    const store = TestBed.inject(FileAgentSettingsStore);

    first.selectProfile('p-shared');
    expect(store.selectedProfileId()).toBe('p-shared');
    // FileAgentService.selectedProfileId is the SAME signal object as the
    // store's — so any second instance reading svc.selectedProfileId() sees
    // the live shared value, no per-instance staleness.
    expect(first.selectedProfileId).toBe(store.selectedProfileId);
  });

  it('records a failure timestamp instead of poisoning the cache when the probe throws', async () => {
    let calls = 0;
    const failingProbe = (): Promise<boolean> => {
      calls++;
      return Promise.reject(new Error('network timeout'));
    };

    const profile = { id: 'p-1', provider: 'test-provider', settings: {} };
    const { svc } = setup({
      mainChatActive: 'p-1',
      profiles: [profile],
      providerCaps: { supportsNativeToolCalls: false }, // static default would say JSON
      probeNativeToolSupport: failingProbe
    });

    await svc.capability.kickToolSupportProbe('p-1');
    expect(calls).toBe(1);

    // Failure must NOT promote to probeResults — otherwise a flaky cold-start
    // would freeze the verdict to JSON forever. The reason therefore stays
    // on the static-default branch, NOT "(probed)".
    const store = TestBed.inject(FileAgentSettingsStore);
    expect(store.probeResults()['p-1']).toBeUndefined();
    expect(typeof store.probeFailureTimestamps()['p-1']).toBe('number');
    expect(svc.capability.effectiveToolCallReason()).toBe('Auto: JSON (default)');
  });

  it('skips re-attempt within the failure TTL window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1));
    let calls = 0;
    const probe = (): Promise<boolean> => {
      calls++;
      return Promise.reject(new Error('network timeout'));
    };

    const profile = { id: 'p-1', provider: 'test-provider', settings: {} };
    const { svc } = setup({
      mainChatActive: 'p-1',
      profiles: [profile],
      probeNativeToolSupport: probe
    });

    await svc.capability.kickToolSupportProbe('p-1');
    expect(calls).toBe(1);

    // 5s elapsed — still inside the 10s TTL → must NOT re-fire.
    vi.advanceTimersByTime(5_000);
    await svc.capability.kickToolSupportProbe('p-1');
    expect(calls).toBe(1);
  });

  it('re-attempts the probe after the failure TTL elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1));
    let calls = 0;
    let nextResult: boolean | null = null;
    const probe = (): Promise<boolean> => {
      calls++;
      if (nextResult === null) return Promise.reject(new Error('cold start'));
      return Promise.resolve(nextResult);
    };

    const profile = { id: 'p-1', provider: 'test-provider', settings: {} };
    const { svc } = setup({
      mainChatActive: 'p-1',
      profiles: [profile],
      providerCaps: { supportsNativeToolCalls: false }, // default would say JSON
      probeNativeToolSupport: probe
    });

    await svc.capability.kickToolSupportProbe('p-1');
    expect(calls).toBe(1);
    expect(svc.capability.effectiveToolCallReason()).toBe('Auto: JSON (default)');

    // 11s elapsed — beyond the 10s TTL → next kick must retry. This time
    // the endpoint is warm and reports native support, so the verdict flips
    // permanently to probed=true.
    vi.advanceTimersByTime(11_000);
    nextResult = true;
    await svc.capability.kickToolSupportProbe('p-1');
    expect(calls).toBe(2);

    const store = TestBed.inject(FileAgentSettingsStore);
    expect(store.probeResults()['p-1']).toBe(true);
    expect(store.probeFailureTimestamps()['p-1']).toBeUndefined(); // cleared on success
    expect(svc.capability.effectiveToolCallReason()).toBe('Auto: Native (probed)');
  });

  it('parallel kickToolSupportProbe calls dedupe via the store inflight set', async () => {
    let calls = 0;
    let release!: (v: boolean) => void;
    const probe = (): Promise<boolean> => {
      calls++;
      return new Promise<boolean>(r => { release = r; });
    };

    const profile = { id: 'p-1', provider: 'test-provider', settings: {} };
    const { svc } = setup({
      mainChatActive: 'p-1',
      profiles: [profile],
      probeNativeToolSupport: probe
    });

    // Two parallel kicks from the same resolver (simulates two sibling
    // FileAgentService instances both reacting to the shared selectedProfileId
    // signal). The inflight Set on the shared store must short-circuit the
    // second one — only ONE probe should actually fire.
    const p1 = svc.capability.kickToolSupportProbe('p-1');
    const p2 = svc.capability.kickToolSupportProbe('p-1');
    expect(calls).toBe(1);

    release(true);
    await Promise.all([p1, p2]);

    // Verdict recorded once; second call short-circuited.
    const store = TestBed.inject(FileAgentSettingsStore);
    expect(store.probeResults()['p-1']).toBe(true);

    // After the in-flight promise resolves, a follow-up kick should also
    // short-circuit (via `alreadyProbed`) without re-invoking the probe.
    await svc.capability.kickToolSupportProbe('p-1');
    expect(calls).toBe(1);
  });

  it('resolver sees a probe verdict the store recorded (probe sharing end-to-end)', () => {
    // Reproduce the live bug: two surfaces of the file-agent must converge
    // on the same "Auto: Native (probed)" reason once any one of them has
    // landed a probe verdict for the active profile.
    const profile = { id: 'p-1', provider: 'test-provider', settings: {} };
    const { svc } = setup({
      mainChatActive: 'p-1',
      profiles: [profile],
      providerCaps: { supportsNativeToolCalls: false } // static default would say JSON
    });

    // Before any probe: falls back to the provider's static cap → JSON (default).
    expect(svc.capability.effectiveToolCallReason()).toBe('Auto: JSON (default)');

    // Sibling instance (or this one's own probe) records native=true in the store.
    const store = TestBed.inject(FileAgentSettingsStore);
    store.recordProbeResult('p-1', true);

    // Resolver's computed must immediately reflect the shared verdict.
    expect(svc.capability.effectiveToolCallReason()).toBe('Auto: Native (probed)');
  });

  it('subsequent service instance picks up the KV choice (cross-invocation sharing)', () => {
    // First instance writes its choice.
    const { svc: first } = setup({ mainChatActive: 'p-main' });
    first.selectProfile('p-shared');

    // Re-create the service (simulating a fresh file-viewer dialog opening
    // later) — must read the same KV value, NOT main-chat's active id.
    TestBed.resetTestingModule();
    const kv = new InMemoryKVStore({ [FILE_AGENT_PROFILE_KEY]: 'p-shared' });
    TestBed.configureTestingModule({
      providers: [
        FileAgentService,
        { provide: KVStore, useValue: kv },
        { provide: LLMConfigService, useValue: { profiles: signal([]), activeProfileId: signal('p-different-main') } },
        { provide: LLMProviderRegistryService, useValue: { getProvider: () => null } },
        { provide: BookRepository, useValue: { list: () => Promise.resolve([]) } },
        { provide: CollectionService, useValue: { collections: signal([]), load: () => Promise.resolve() } },
        { provide: SessionService, useValue: { currentBookId: () => null } }
      ]
    });
    const second = TestBed.inject(FileAgentService);
    expect(second.selectedProfileId()).toBe('p-shared');
  });
});
