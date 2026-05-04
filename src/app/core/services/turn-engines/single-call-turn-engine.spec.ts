import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SingleCallTurnEngine } from './single-call-turn-engine.service';
import { StreamProcessorService } from '../stream-processor.service';
import { ContentParserService } from '../content-parser.service';
import { PostProcessorService } from '../post-processor.service';
import { GameStateService } from '../game-state.service';
import { MockLLMProvider } from '@app/core/testing/mock-llm-provider';
import type { ChatMessage } from '@app/core/models/types';

function turnJson(story: string, summary = 's'): string {
    return JSON.stringify({ analysis: '', response: { story, summary } });
}

describe('SingleCallTurnEngine.runTurn', () => {
    let mockProvider: MockLLMProvider;
    let messages: ChatMessage[];
    const updateMessages = (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
        messages = updater(messages);
    };

    beforeEach(() => {
        mockProvider = new MockLLMProvider();
        messages = [];

        // PostProcessorService reads `postProcessScript` off GameStateService.
        // The engine itself no longer touches state, but its delegate
        // (StreamProcessorService → PostProcessorService) still does.
        const fakeState: Partial<GameStateService> = {
            postProcessScript: signal(''),
            config: signal({ outputLanguage: 'default' })
        } as unknown as Partial<GameStateService>;

        TestBed.configureTestingModule({
            providers: [
                SingleCallTurnEngine,
                StreamProcessorService,
                ContentParserService,
                PostProcessorService,
                { provide: GameStateService, useValue: fakeState }
            ]
        });
    });

    function input(extra: { systemInstruction?: string; cachedContentName?: string } = {}) {
        return {
            provider: mockProvider,
            providerConfig: {},
            cachedContentName: extra.cachedContentName,
            systemInstruction: extra.systemInstruction ?? 'SYS-FROM-CALLER',
            history: [{ role: 'user' as const, parts: [{ text: 'walk forward' }] }],
            intent: 'action',
            outputLanguage: 'default',
            modelMsgId: 'm1',
            signal: new AbortController().signal,
            updateMessages
        };
    }

    it('forwards caller-resolved systemInstruction and cachedContentName to the provider call', async () => {
        mockProvider.enqueueJsonStream(turnJson('she walked forward.'));

        const engine = TestBed.inject(SingleCallTurnEngine);
        await engine.runTurn(input({ systemInstruction: 'CUSTOM-SI', cachedContentName: 'cache-abc' }));

        expect(mockProvider.calls).toHaveLength(1);
        expect(mockProvider.calls[0].systemInstruction).toBe('CUSTOM-SI');
        expect(mockProvider.calls[0].genConfig.cachedContentName).toBe('cache-abc');
    });

    it('omits cachedContentName from the provider call when input has none', async () => {
        mockProvider.enqueueJsonStream(turnJson('s'));

        const engine = TestBed.inject(SingleCallTurnEngine);
        await engine.runTurn(input());

        expect(mockProvider.calls[0].genConfig.cachedContentName).toBeUndefined();
    });

    it('forwards intent + signal + a response schema to the provider', async () => {
        mockProvider.enqueueJsonStream(turnJson('s'));

        const engine = TestBed.inject(SingleCallTurnEngine);
        const ac = new AbortController();
        const inp = { ...input(), signal: ac.signal };
        await engine.runTurn(inp);

        const call = mockProvider.calls[0];
        expect(call.genConfig.intent).toBe('action');
        expect(call.genConfig.signal).toBe(ac.signal);
        expect(call.genConfig.responseMimeType).toBe('application/json');
        expect(call.genConfig.responseSchema).toBeDefined();
    });

    it('returns the parsed story from the streamed JSON', async () => {
        mockProvider.enqueueJsonStream(turnJson('hello world'));

        const engine = TestBed.inject(SingleCallTurnEngine);
        const result = await engine.runTurn(input());

        expect(result.finalStory).toContain('hello world');
    });

    it('uses caller-supplied provider rather than any DI singleton', async () => {
        // The engine has no `inject(LLMProviderRegistryService)` and no
        // `inject(GameStateService)`. If a future regression re-adds them,
        // this spec's TestBed would have to grow new fakes — making the
        // breakage loud. For now, the only thing we have to register is
        // the StreamProcessor delegate's GameStateService.
        mockProvider.enqueueJsonStream(turnJson('s'));

        const otherProvider = new MockLLMProvider();
        otherProvider.enqueueJsonStream(turnJson('OTHER'));

        const engine = TestBed.inject(SingleCallTurnEngine);
        await engine.runTurn({ ...input(), provider: otherProvider });

        // mockProvider was never called; otherProvider was.
        expect(mockProvider.calls).toHaveLength(0);
        expect(otherProvider.calls).toHaveLength(1);
    });
});
