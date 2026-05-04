import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { CacheManagerService, CacheCheckInput } from './cache-manager.service';
import { GameStateService } from './game-state.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { CostService } from './cost.service';
import { KnowledgeService } from './knowledge.service';
import { ChatHistoryService } from './chat-history.service';
import type { LLMCacheInfo, LLMProvider, LLMProviderCapabilities } from '@hcs/llm-core';

interface FakeProviderOpts {
    getCache?: (name: string) => Promise<LLMCacheInfo | null>;
    updateCacheTTL?: (name: string, ttl: number) => Promise<LLMCacheInfo | null>;
    createCache?: () => Promise<LLMCacheInfo | null>;
    deleteCalls?: string[];
}

function makeFakeProvider(opts: FakeProviderOpts = {}): LLMProvider {
    const deleteCalls = opts.deleteCalls ?? [];
    return {
        providerName: 'fake',
        async *generateContentStream() { /* unused */ },
        async countTokens() { return 0; },
        isConfigured() { return true; },
        getCapabilities(): LLMProviderCapabilities {
            return { cacheBakesContent: true } as LLMProviderCapabilities;
        },
        getAvailableModels() { return []; },
        getDefaultModelId() { return 'fake-model'; },
        getCache: opts.getCache,
        updateCacheTTL: opts.updateCacheTTL,
        createCache: opts.createCache,
        async deleteCache(_cfg, name: string) { deleteCalls.push(name); }
    } as unknown as LLMProvider;
}

function baseInput(provider: LLMProvider, overrides: Partial<CacheCheckInput> = {}): CacheCheckInput {
    return {
        provider,
        providerConfig: {},
        enableCache: true,
        modelId: 'm1',
        systemInstruction: 'SYS',
        loadedFiles: new Map([['a.md', 'KB']]),
        currentCacheName: null,
        currentCacheHash: null,
        currentCacheTokens: 0,
        currentCacheExpireTime: null,
        ...overrides
    };
}

describe('CacheManagerService.checkCacheAndRefresh', () => {
    let svc: CacheManagerService;

    beforeEach(() => {
        // CacheManager still injects GameStateService for storageUsageAccumulated
        // (cost-side bookkeeping, deliberately not moved per plan) and uses
        // CostService internally. Provide minimal fakes.
        const fakeState: Partial<GameStateService> = {
            storageUsageAccumulated: signal(0),
            historyStorageUsageAccumulated: signal(0),
            kbCacheName: signal<string | null>(null),
            kbCacheExpireTime: signal<number | null>(null),
            kbCacheHash: signal<string | null>(null),
            kbCacheTokens: signal(0),
            config: signal({ outputLanguage: 'default', modelId: 'm1' }),
            status: signal('idle')
        } as unknown as Partial<GameStateService>;

        TestBed.configureTestingModule({
            providers: [
                CacheManagerService,
                CostService,
                KnowledgeService,
                { provide: GameStateService, useValue: fakeState },
                { provide: LLMProviderRegistryService, useValue: { getActive: () => null, getActiveConfig: () => ({}) } },
                { provide: ChatHistoryService, useValue: { recordSunkUsage: () => undefined } }
            ]
        });
        svc = TestBed.inject(CacheManagerService);
    });

    describe('recovery path (no current cache)', () => {
        it('creates a new cache and returns its name + new hash + tokens + sunkUsage', async () => {
            const provider = makeFakeProvider({
                createCache: async () => ({
                    name: 'new-cache-xyz',
                    displayName: 'new-cache-xyz',
                    model: 'm1',
                    createTime: Date.now(),
                    expireTime: Date.now() + 1800_000,
                    usageMetadata: { totalTokenCount: 500 }
                })
            });

            const result = await svc.checkCacheAndRefresh(baseInput(provider));

            expect(result.cacheName).toBe('new-cache-xyz');
            expect(result.tokens).toBe(500);
            expect(result.hash).toBeTruthy();
            expect(result.sunkUsageTokens).toBe(500);
        });

        it('reports sunkUsageTokens = 0 when the new cache reports 0 tokens', async () => {
            const provider = makeFakeProvider({
                createCache: async () => ({
                    name: 'c', displayName: 'c', model: 'm1',
                    createTime: Date.now(), expireTime: Date.now() + 1800_000,
                    usageMetadata: { totalTokenCount: 0 }
                })
            });

            const result = await svc.checkCacheAndRefresh(baseInput(provider));
            expect(result.sunkUsageTokens).toBe(0);
        });

        it('throws SESSION_EXPIRED when there are no local files to recover from', async () => {
            const provider = makeFakeProvider();

            await expect(
                svc.checkCacheAndRefresh(baseInput(provider, { loadedFiles: new Map() }))
            ).rejects.toThrow('SESSION_EXPIRED');
        });
    });

    describe('validated path (current cache present)', () => {
        it('returns existing cache info with bumped expireTime when getCache + updateCacheTTL succeed', async () => {
            const newExpire = Date.now() + 1800_000;
            const provider = makeFakeProvider({
                getCache: async () => ({
                    name: 'existing', displayName: 'existing', model: 'm1',
                    createTime: 0, expireTime: 0,
                    usageMetadata: { totalTokenCount: 700 }
                }),
                updateCacheTTL: async () => ({
                    name: 'existing', displayName: 'existing', model: 'm1',
                    createTime: 0, expireTime: newExpire,
                    usageMetadata: undefined
                })
            });

            // Caller passes the same hash on input as the service computes,
            // so the staleness branch doesn't fire. Recompute it here from
            // the same primitives KnowledgeService uses.
            const kb = TestBed.inject(KnowledgeService);
            const fileParts = kb.buildKnowledgeBaseParts(new Map([['a.md', 'KB']]));
            const expectedHash = kb.calculateKbHash(
                fileParts.map(p => p.text).join(''),
                'm1', 'SYS'
            );

            const result = await svc.checkCacheAndRefresh(baseInput(provider, {
                currentCacheName: 'existing',
                currentCacheHash: expectedHash,
                currentCacheTokens: 700
            }));

            expect(result.cacheName).toBe('existing');
            expect(result.expireTime).toBe(newExpire);
            expect(result.tokens).toBe(700);
            expect(result.sunkUsageTokens).toBe(0);  // no creation = no sunk usage
        });
    });

    describe('hash mismatch path', () => {
        it('deletes stale cache, then creates a fresh one — both surfacing in the result', async () => {
            const deleteCalls: string[] = [];
            const provider = makeFakeProvider({
                // The staleness branch only fires when provider.getCache is
                // defined (the validation block is gated on it). We define
                // it here even though it won't be reached on this path.
                getCache: async () => null,
                createCache: async () => ({
                    name: 'fresh-xyz', displayName: 'fresh-xyz', model: 'm1',
                    createTime: Date.now(), expireTime: Date.now() + 1800_000,
                    usageMetadata: { totalTokenCount: 800 }
                }),
                deleteCalls
            });

            const result = await svc.checkCacheAndRefresh(baseInput(provider, {
                currentCacheName: 'stale-old',
                currentCacheHash: 'STALE-HASH'
            }));

            // Server-side delete on the stale name
            expect(deleteCalls).toContain('stale-old');
            // Result reflects the freshly-minted cache, not the stale one
            expect(result.cacheName).toBe('fresh-xyz');
            expect(result.tokens).toBe(800);
            expect(result.sunkUsageTokens).toBe(800);
            // Hash should be the fresh recomputed one, not the stale input
            expect(result.hash).not.toBe('STALE-HASH');
        });
    });

    describe('cache-disabled mode', () => {
        it('returns nulled state when leftover cache exists and useCache is false', async () => {
            const deleteCalls: string[] = [];
            const provider = makeFakeProvider({ deleteCalls });

            const result = await svc.checkCacheAndRefresh(baseInput(provider, {
                enableCache: false,
                currentCacheName: 'leftover-from-prior-mode',
                currentCacheHash: 'h',
                currentCacheTokens: 999,
                currentCacheExpireTime: Date.now() + 1800_000
            }));

            expect(deleteCalls).toContain('leftover-from-prior-mode');
            expect(result.cacheName).toBeNull();
            expect(result.expireTime).toBeNull();
            expect(result.hash).toBeNull();
            expect(result.tokens).toBe(0);
        });

        it('passes through with no-op when useCache is false and there is no leftover cache', async () => {
            const provider = makeFakeProvider();

            const result = await svc.checkCacheAndRefresh(baseInput(provider, {
                enableCache: false,
                currentCacheName: null,
                currentCacheHash: null
            }));

            expect(result.cacheName).toBeNull();
            expect(result.sunkUsageTokens).toBe(0);
        });
    });
});
