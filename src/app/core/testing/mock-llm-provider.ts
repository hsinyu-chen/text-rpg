import {
    LLMContent,
    LLMGenerateConfig,
    LLMModelDefinition,
    LLMProvider,
    LLMProviderCapabilities,
    LLMProviderConfig,
    LLMStreamChunk,
    LLMUsageMetadata
} from '@hcs/llm-core';

interface MockCall {
    contents: LLMContent[];
    systemInstruction: string;
    genConfig: LLMGenerateConfig;
}

/**
 * In-memory LLM provider for orchestrator + engine specs.
 *
 * Each call to {@link generateContentStream} consumes the next queued
 * script (FIFO). Scripts are arrays of {@link LLMStreamChunk}; tests
 * usually want a sequence of `{ text }` chunks followed by a final
 * `{ usageMetadata }` chunk to mimic real provider output.
 *
 * The mock records every invocation in {@link calls} so specs can
 * assert on what the orchestrator actually sent — schema, system
 * instruction, or the user-message tail of the contents array.
 */
export class MockLLMProvider implements LLMProvider {
    readonly providerName = 'mock';

    private scripts: LLMStreamChunk[][] = [];
    readonly calls: MockCall[] = [];

    /**
     * Queues the next script. The N-th call to generateContentStream
     * yields the N-th script.
     */
    enqueueScript(chunks: LLMStreamChunk[]): void {
        this.scripts.push(chunks);
    }

    /**
     * Convenience: queue a script that emits the JSON text in N
     * roughly-equal chunks plus a final usageMetadata frame. Useful
     * when the test does not care about per-chunk granularity.
     */
    enqueueJsonStream(text: string, options: { chunkCount?: number; usage?: Partial<LLMUsageMetadata> } = {}): void {
        const chunkCount = Math.max(1, options.chunkCount ?? 1);
        const chunks: LLMStreamChunk[] = [];
        const sliceLen = Math.ceil(text.length / chunkCount);
        for (let i = 0; i < chunkCount; i++) {
            chunks.push({ text: text.slice(i * sliceLen, (i + 1) * sliceLen) });
        }
        chunks.push({
            usageMetadata: {
                prompt: options.usage?.prompt ?? 0,
                candidates: options.usage?.candidates ?? 0,
                cached: options.usage?.cached ?? 0,
                ...options.usage
            }
        });
        this.enqueueScript(chunks);
    }

    pendingScriptCount(): number {
        return this.scripts.length;
    }

    async *generateContentStream(
        config: LLMProviderConfig,
        contents: LLMContent[],
        systemInstruction: string,
        genConfig: LLMGenerateConfig
    ): AsyncIterable<LLMStreamChunk> {
        void config;
        this.calls.push({ contents, systemInstruction, genConfig });
        const script = this.scripts.shift();
        if (!script) {
            throw new Error('MockLLMProvider: no script enqueued for this call (call #' + this.calls.length + ')');
        }
        for (const chunk of script) {
            yield chunk;
        }
    }

    async countTokens(): Promise<number> {
        return 0;
    }

    isConfigured(): boolean {
        return true;
    }

    getCapabilities(): LLMProviderCapabilities {
        return {
            supportsContextCaching: false,
            supportsThinking: false,
            supportsStructuredOutput: true,
            isLocalProvider: false,
            supportsSpeedMetrics: false,
            cacheBakesContent: true
        };
    }

    getAvailableModels(): LLMModelDefinition[] {
        return [];
    }

    getDefaultModelId(): string {
        return 'mock-model';
    }
}
