import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SaveAgentRunnerService } from './save-agent-runner.service';
import { SaveProgressTracker } from './progress/save-progress-tracker.service';
import { ContentParserService } from '../content-parser.service';
import { MockLLMProvider } from '@app/core/testing/mock-llm-provider';
import type { LLMProviderConfig } from '@hcs/llm-core';

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return {
        runner: TestBed.inject(SaveAgentRunnerService),
        tracker: TestBed.inject(SaveProgressTracker),
        parser: TestBed.inject(ContentParserService),
    };
}

const minimalAudit = '"completenessAudit":{"processedLogIds":[],"skippedLogIds":[]}';
const minimalManifest = `{${minimalAudit}}`;

function defaultInput(provider: MockLLMProvider) {
    return {
        provider,
        providerConfig: { apiKey: '', modelId: 'm', name: 'p' } as unknown as LLMProviderConfig,
        systemInstruction: 'sys',
        history: [{ role: 'user' as const, parts: [{ text: 'go' }] }],
        signal: new AbortController().signal,
    };
}

describe('SaveAgentRunnerService', () => {
    beforeEach(() => {
        // Reset between tests so the tracker doesn't accumulate cross-spec
        // entries — the service is providedIn:'root' so it persists across
        // TestBed.resetTestingModule.
        setup().tracker.reset();
    });

    it('passes the manifest schema to the provider with JSON mime type', async () => {
        const { runner } = setup();
        const provider = new MockLLMProvider();
        provider.enqueueJsonStream(minimalManifest);

        await runner.run(defaultInput(provider));

        const call = provider.calls[0];
        expect(call.genConfig.responseMimeType).toBe('application/json');
        expect(call.genConfig.responseSchema).toBeDefined();
        expect((call.genConfig.responseSchema as { properties: Record<string, unknown> }).properties).toHaveProperty('inventoryDeltas');
    });

    it('parses a streamed-in-chunks manifest', async () => {
        const { runner } = setup();
        const provider = new MockLLMProvider();
        provider.enqueueJsonStream(minimalManifest, { chunkCount: 4 });

        const result = await runner.run(defaultInput(provider));

        expect(result.manifest.completenessAudit.processedLogIds).toEqual([]);
        expect(result.rawJson).toBe(minimalManifest);
    });

    it('records SaveAgent progress entry as done when manifest is valid', async () => {
        const { runner, tracker } = setup();
        const provider = new MockLLMProvider();
        provider.enqueueJsonStream(minimalManifest);

        await runner.run(defaultInput(provider));

        const entries = tracker.entries();
        expect(entries).toHaveLength(1);
        expect(entries[0].phase).toBe('manifest');
        expect(entries[0].toolName).toBe('SaveAgent');
        expect(entries[0].state).toBe('done');
        expect(entries[0].output).toBe(minimalManifest);
    });

    it('accumulates thought chunks separately from output', async () => {
        const { runner, tracker } = setup();
        const provider = new MockLLMProvider();
        provider.enqueueScript([
            { text: 'reasoning A', thought: true },
            { text: 'reasoning B', thought: true },
            { text: minimalManifest },
            { usageMetadata: { prompt: 100, candidates: 50, cached: 80 } },
        ]);

        const result = await runner.run(defaultInput(provider));

        expect(result.thought).toBe('reasoning Areasoning B');
        const entry = tracker.entries()[0];
        expect(entry.thought).toBe('reasoning Areasoning B');
        expect(entry.output).toBe(minimalManifest);
    });

    it('captures usage and prompt-processing progress', async () => {
        const { runner, tracker } = setup();
        const provider = new MockLLMProvider();
        provider.enqueueScript([
            { usageMetadata: { prompt: 0, candidates: 0, cached: 0, promptProgress: 0.5 } },
            { text: minimalManifest },
            { usageMetadata: { prompt: 1000, candidates: 100, cached: 800 } },
        ]);

        const result = await runner.run(defaultInput(provider));

        expect(result.usage.prompt).toBe(1000);
        expect(result.usage.cached).toBe(800);
        const entry = tracker.entries()[0];
        expect(entry.ppProgress).toBe(0.5);
        expect(entry.usage?.cached).toBe(800);
    });

    it('marks the entry failed and throws when manifest fails validation', async () => {
        const { runner, tracker } = setup();
        const provider = new MockLLMProvider();
        // Non-object → fails the top-level isObject check (which still rejects).
        provider.enqueueJsonStream('[]');

        await expect(runner.run(defaultInput(provider))).rejects.toThrow(/manifest invalid/);
        const entry = tracker.entries()[0];
        expect(entry.state).toBe('failed');
        expect(entry.statusReason).toMatch(/manifest invalid/);
    });

    it('marks the entry failed and rethrows when the stream errors mid-flight', async () => {
        const { runner, tracker } = setup();

        const failingProvider = {
            providerName: 'fail',
            async *generateContentStream() {
                yield { text: '{' };
                throw new Error('connection reset');
            },
        };

        await expect(runner.run({
            ...defaultInput(failingProvider as unknown as MockLLMProvider),
        })).rejects.toThrow(/connection reset/);
        const entry = tracker.entries()[0];
        expect(entry.state).toBe('failed');
        expect(entry.statusReason).toMatch(/connection reset/);
    });
});
