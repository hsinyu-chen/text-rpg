import { Injectable } from '@angular/core';
import {
    LLMProvider,
    LLMProviderCapabilities,
    LLMProviderConfig,
    LLMContent,
    LLMGenerateConfig,
    LLMStreamChunk,
    LLMModelDefinition
} from './llm-provider';

/**
 * LlamaService - llama.cpp Server Provider (With Schema Injection Shim)
 * * Includes "Schema Injection" logic to force local models to follow 
 * complex JSON structures defined in GameEngine.
 */
@Injectable({
    providedIn: 'root'
})
export class LlamaService implements LLMProvider {
    readonly providerName = 'llama.cpp';

    private baseUrl = 'http://localhost:8080';
    private modelId = 'local-model';

    init(config: LLMProviderConfig): void {
        if (config.baseUrl) {
            this.baseUrl = config.baseUrl.replace(/\/$/, '');
        }
        if (config.modelId) {
            this.modelId = config.modelId;
        }
    }

    getCapabilities(): LLMProviderCapabilities {
        return {
            supportsContextCaching: false, // Local handles caching implicitly
            supportsThinking: false,
            supportsStructuredOutput: true, // Supported via Shim + JSON Mode
            isLocalProvider: true
        };
    }

    getAvailableModels(): LLMModelDefinition[] {
        return [
            {
                id: this.modelId,
                name: `Local Model (${this.modelId})`,
                getRates: () => ({ input: 0, output: 0, cached: 0, cacheStorage: 0 })
            }
        ];
    }

    getDefaultModelId(): string {
        return this.modelId;
    }

    async *generateContentStream(
        contents: LLMContent[],
        systemInstruction: string,
        config: LLMGenerateConfig
    ): AsyncGenerator<LLMStreamChunk> {

        // 1. Inject Schema into System Prompt (Crucial for Local Models!)
        const messages = this.toOpenAIMessages(
            contents,
            systemInstruction,
            config.responseSchema // Pass schema to helper
        );

        // 2. Build Request
        const requestBody = {
            model: this.modelId,
            messages,
            stream: true,

            repeat_penalty: 1.1,

            // Force valid JSON Syntax
            ...(config.responseSchema && {
                response_format: { type: 'json_object' }
            })
        };

        try {
            const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal: config.signal
            });

            if (!response.ok) {
                throw new Error(`llama.cpp error (${response.status}): ${await response.text()}`);
            }

            if (!response.body) throw new Error('No response body from server.');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data: ')) continue;

                        const data = trimmed.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.choices?.[0]?.delta;

                            if (delta?.content) {
                                yield { text: delta.content };
                            }

                            const finishReason = parsed.choices?.[0]?.finish_reason;
                            if (finishReason) {
                                yield { finishReason };
                            }

                            if (parsed.usage) {
                                yield {
                                    usageMetadata: {
                                        promptTokens: parsed.usage.prompt_tokens || 0,
                                        completionTokens: parsed.usage.completion_tokens || 0
                                    }
                                };
                            }
                        } catch { /* Ignore partial chunks */ }
                    }
                }
            } finally {
                reader.releaseLock();
            }

        } catch (error: unknown) {
            const err = error as { name?: string, message?: string };
            if (err.name === 'TypeError' && err.message?.includes('fetch')) {
                throw new Error(`Connection Failed: Check if llama.cpp server is running at ${this.baseUrl}`);
            }
            throw error;
        }
    }

    async countTokens(_modelId: string, contents: LLMContent[]): Promise<number> {
        const text = contents.flatMap(c => c.parts).map(p => p.text || '').join('\n');
        if (!text) return 0;
        try {
            const response = await fetch(`${this.baseUrl}/tokenize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: text })
            });
            if (response.ok) {
                const data = await response.json();
                return Array.isArray(data.tokens) ? data.tokens.length : 0;
            }
        } catch { /* Ignore token counting errors */ }
        return Math.ceil(text.length / 3.5);
    }

    // =========================================================================
    // Helper Methods
    // =========================================================================

    private toOpenAIMessages(
        contents: LLMContent[],
        systemInstruction: string,
        schema?: object // Accept schema
    ): { role: string; content: string }[] {
        const messages: { role: string; content: string }[] = [];

        let finalSystemInstruction = systemInstruction || '';

        // [SHIM] Inject Schema Definition into System Prompt
        // This tells Qwen/Llama exactly WHAT fields to generate
        if (schema) {
            finalSystemInstruction += `\n\n[SYSTEM REQUIREMENT: STRUCTURED OUTPUT]\nYou must STRICTLY output a valid JSON object adhering to the following schema. Do NOT wrap in markdown blocks.\n${JSON.stringify(schema, null, 2)}`;
        }

        if (finalSystemInstruction) {
            messages.push({ role: 'system', content: finalSystemInstruction });
        }

        for (const content of contents) {
            const role = content.role === 'model' ? 'assistant' : content.role;
            const text = content.parts.map(p => p.text || '').filter(t => t).join('\n');
            if (text) {
                messages.push({ role, content: text });
            }
        }

        return messages;
    }
}