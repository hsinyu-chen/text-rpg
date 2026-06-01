import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HunkAutoFixService, HunkAutoFixInput } from './hunk-auto-fix.service';
import { LLMProviderRegistryService } from '@app/core/services/llm-provider-registry.service';
import { LLMConfigService } from '@app/core/services/llm-config.service';
import { ContentParserService } from '@app/core/services/content-parser.service';
import { SaveSettingsStore } from '@app/core/services/multi-agent-save/save-settings.store';
import { KVStore } from '@app/core/services/kv/kv-store';
import { InMemoryKVStore } from '@app/core/testing/in-memory-kv-store';
import { MockLLMProvider } from '@app/core/testing/mock-llm-provider';
import type { LLMConfig, LLMProviderConfig } from '@hcs/llm-core';

class StubLLMConfigService {
    private list: LLMConfig[] = [];
    private activeId: string | null = null;
    profiles = () => this.list;
    activeProfileId = () => this.activeId;
    activeProviderName = () => this.list.find(p => p.id === this.activeId)?.provider ?? 'mock';
    getActiveConfig(): LLMProviderConfig {
        return this.list.find(p => p.id === this.activeId)?.settings ?? {};
    }
    set(profiles: LLMConfig[], activeId: string | null): void {
        this.list = profiles;
        this.activeId = activeId;
    }
}

class StubProviderRegistry {
    private byName = new Map<string, MockLLMProvider>();
    private activeId: string | null = null;
    private llmConfig: StubLLMConfigService;

    constructor(llmConfig: StubLLMConfigService) {
        this.llmConfig = llmConfig;
    }

    register(providerName: string, provider: MockLLMProvider): void {
        this.byName.set(providerName, provider);
    }
    setActive(id: string | null): void {
        this.activeId = id;
    }
    getProvider(name: string): MockLLMProvider | undefined {
        return this.byName.get(name);
    }
    getActiveBundle(): { provider: MockLLMProvider; config: LLMProviderConfig } | null {
        if (!this.activeId) return null;
        const profile = this.llmConfig.profiles().find(p => p.id === this.activeId);
        if (!profile) return null;
        const provider = this.byName.get(profile.provider);
        if (!provider) return null;
        return { provider, config: profile.settings };
    }
}

function setup() {
    TestBed.resetTestingModule();
    const llmConfig = new StubLLMConfigService();
    const registry = new StubProviderRegistry(llmConfig);
    TestBed.configureTestingModule({
        providers: [
            HunkAutoFixService,
            { provide: KVStore, useValue: new InMemoryKVStore() },
            { provide: LLMConfigService, useValue: llmConfig },
            { provide: LLMProviderRegistryService, useValue: registry },
        ],
    });
    return {
        service: TestBed.inject(HunkAutoFixService),
        settings: TestBed.inject(SaveSettingsStore),
        llmConfig,
        registry,
        parser: TestBed.inject(ContentParserService),
    };
}

function activeMain(): { llmConfig: StubLLMConfigService; registry: StubProviderRegistry; provider: MockLLMProvider } {
    const ctx = setup();
    const provider = new MockLLMProvider();
    ctx.registry.register('mock', provider);
    const profile: LLMConfig = { id: 'main', name: 'Main', provider: 'mock', settings: { modelId: 'main-m' } };
    ctx.llmConfig.set([profile], 'main');
    ctx.registry.setActive('main');
    return { llmConfig: ctx.llmConfig, registry: ctx.registry, provider };
}

const sampleInput: HunkAutoFixInput = {
    fileName: 'kb.md',
    sourceContent: '- **最後已知位置**: 新手村廣場\n',
    intendedTarget: '- 最後已知位置: 新手村廣場',
    intendedReplacement: '- 最後已知位置: 山洞入口',
    failReason: 'target_not_found',
};

/** A repair candidate whose target IS present verbatim in sampleInput's source. */
const matchingCandidate = JSON.stringify({ target: '- **最後已知位置**: 新手村廣場', replacement: '- **最後已知位置**: 山洞入口', context: [] });
/** A repair candidate whose target is NOT present (missing the ** wrappers). */
const nonMatchingCandidate = JSON.stringify({ target: '- 最後已知位置: 新手村廣場', replacement: '- 最後已知位置: 山洞入口', context: [] });

describe('HunkAutoFixService', () => {
    let baseCtx: ReturnType<typeof activeMain>;

    beforeEach(() => {
        baseCtx = activeMain();
    });

    it('passes the structured-output schema + JSON mime to the provider', async () => {
        baseCtx.provider.enqueueJsonStream(matchingCandidate);
        const service = TestBed.inject(HunkAutoFixService);

        await service.fix(sampleInput);

        const call = baseCtx.provider.calls[0];
        expect(call.genConfig.responseMimeType).toBe('application/json');
        expect((call.genConfig.responseSchema as { required: string[] }).required).toEqual(['target', 'replacement', 'context']);
        expect(call.genConfig.intent).toBe('hunk_auto_fix');
    });

    it('returns a matched candidate (target + context + matched) on a well-formed, source-matching response', async () => {
        baseCtx.provider.enqueueJsonStream(matchingCandidate);
        const service = TestBed.inject(HunkAutoFixService);

        const result = await service.fix(sampleInput);

        expect(result).toEqual({ target: '- **最後已知位置**: 新手村廣場', replacement: '- **最後已知位置**: 山洞入口', context: [], matched: true });
    });

    it('threads failReason into the initial user prompt', async () => {
        baseCtx.provider.enqueueJsonStream(matchingCandidate);
        const service = TestBed.inject(HunkAutoFixService);

        await service.fix({ ...sampleInput, failReason: 'context_mismatch' });

        const firstUserText = baseCtx.provider.calls[0].contents[0].parts[0].text ?? '';
        expect(firstUserText).toContain('WAS found verbatim');
    });

    it('returns null when the provider throws on the first round', async () => {
        // No script enqueued — MockLLMProvider throws on missing script.
        const service = TestBed.inject(HunkAutoFixService);
        expect(await service.fix(sampleInput)).toBeNull();
    });

    it('passes empty strings through as a legal idempotent (matched) result', async () => {
        baseCtx.provider.enqueueJsonStream(JSON.stringify({ target: '', replacement: '', context: [] }));
        const service = TestBed.inject(HunkAutoFixService);

        expect(await service.fix(sampleInput)).toEqual({ target: '', replacement: '', context: [], matched: true });
    });

    it('retries in the SAME conversation when the first candidate does not match, feeding back the failure', async () => {
        baseCtx.provider.enqueueJsonStream(nonMatchingCandidate);
        baseCtx.provider.enqueueJsonStream(matchingCandidate);
        const service = TestBed.inject(HunkAutoFixService);

        const result = await service.fix(sampleInput);

        expect(result?.matched).toBe(true);
        expect(result?.target).toBe('- **最後已知位置**: 新手村廣場');
        expect(baseCtx.provider.calls.length).toBe(2);
        // Second call ran against the accumulated history: original user turn +
        // round-1 model turn + retry-feedback user turn (same array reference).
        const history = baseCtx.provider.calls[1].contents;
        expect(history.length).toBe(3);
        expect(history.map(c => c.role)).toEqual(['user', 'model', 'user']);
        expect(history[2].parts[0].text).toContain('still does not apply');
    });

    it('returns matched:false after exhausting the retry budget without a match', async () => {
        baseCtx.provider.enqueueJsonStream(nonMatchingCandidate);
        baseCtx.provider.enqueueJsonStream(nonMatchingCandidate);
        baseCtx.provider.enqueueJsonStream(nonMatchingCandidate);
        const service = TestBed.inject(HunkAutoFixService);

        const result = await service.fix(sampleInput);

        expect(result?.matched).toBe(false);
        expect(baseCtx.provider.calls.length).toBe(service.maxFixRounds);
    });

    it('honours hunkFixupProfileId when set, dispatching on that profile\'s provider', async () => {
        // Active = main (mock), additional profile 'cheap' on separate provider 'mock-cheap'.
        const cheapProvider = new MockLLMProvider();
        baseCtx.registry.register('mock-cheap', cheapProvider);
        baseCtx.llmConfig.set([
            { id: 'main', name: 'Main', provider: 'mock', settings: { modelId: 'main-m' } },
            { id: 'cheap', name: 'Cheap', provider: 'mock-cheap', settings: { modelId: 'cheap-m' } },
        ], 'main');

        TestBed.inject(SaveSettingsStore).setHunkFixupProfileId('cheap');
        cheapProvider.enqueueJsonStream(matchingCandidate);

        const service = TestBed.inject(HunkAutoFixService);
        await service.fix(sampleInput);

        expect(cheapProvider.calls.length).toBe(1);
        expect(baseCtx.provider.calls.length).toBe(0);
        // Profile-specific config flowed through (not the active main config).
        expect(cheapProvider.calls[0].genConfig).toBeDefined();
    });

    it('falls back to active main profile when hunkFixupProfileId points at a deleted profile', async () => {
        TestBed.inject(SaveSettingsStore).setHunkFixupProfileId('ghost-profile');
        baseCtx.provider.enqueueJsonStream(matchingCandidate);

        const service = TestBed.inject(HunkAutoFixService);
        await service.fix(sampleInput);

        expect(baseCtx.provider.calls.length).toBe(1);
    });
});
