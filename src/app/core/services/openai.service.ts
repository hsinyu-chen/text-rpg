import { Injectable, signal, Type } from '@angular/core';
import {
    LLMProvider,
    LLMProviderCapabilities,
    LLMProviderConfig,
    LLMContent,
    LLMGenerateConfig,
    LLMStreamChunk,
    LLMModelDefinition,
    LLMSettingsComponent
} from './llm-provider';

/**
 * OpenAIService - OpenAI-Compatible Provider
 * Supports standard /v1/chat/completions endpoint.
 */
@Injectable({
    providedIn: 'root'
})
export class OpenAIService implements LLMProvider {
    readonly providerName = 'openai';
    settingsComponent?: Type<LLMSettingsComponent>;

    private baseUrl = signal('https://api.openai.com/v1');
    private apiKey = signal('');
    private modelId = signal('gpt-4o');
    private temperature = signal(0.7);
    private inputPrice = signal(0);
    private outputPrice = signal(0);

    constructor() {
        this.loadSettings();
    }

    private loadSettings(): void {
        this.baseUrl.set(localStorage.getItem('openai_base_url') || 'https://api.openai.com/v1');
        this.apiKey.set(localStorage.getItem('openai_api_key') || '');
        this.modelId.set(localStorage.getItem('openai_model_id') || 'gpt-4o');
        const savedTemp = localStorage.getItem('openai_temperature');
        if (savedTemp) {
            this.temperature.set(parseFloat(savedTemp));
        }
        this.inputPrice.set(parseFloat(localStorage.getItem('openai_input_price') || '0'));
        this.outputPrice.set(parseFloat(localStorage.getItem('openai_output_price') || '0'));
    }

    private updateSettings(settings: { baseUrl?: string; apiKey?: string; modelId?: string; temperature?: number, inputPrice?: number, outputPrice?: number }): void {
        if (settings.baseUrl) {
            const cleanedUrl = settings.baseUrl.replace(/\/$/, '');
            this.baseUrl.set(cleanedUrl);
            localStorage.setItem('openai_base_url', cleanedUrl);
        }
        if (settings.apiKey !== undefined) {
            this.apiKey.set(settings.apiKey);
            localStorage.setItem('openai_api_key', settings.apiKey);
        }
        if (settings.modelId) {
            this.modelId.set(settings.modelId);
            localStorage.setItem('openai_model_id', settings.modelId);
        }
        if (settings.temperature !== undefined) {
            this.temperature.set(settings.temperature);
            localStorage.setItem('openai_temperature', settings.temperature.toString());
        }
        if (settings.inputPrice !== undefined) {
            this.inputPrice.set(settings.inputPrice);
            localStorage.setItem('openai_input_price', settings.inputPrice.toString());
        }
        if (settings.outputPrice !== undefined) {
            this.outputPrice.set(settings.outputPrice);
            localStorage.setItem('openai_output_price', settings.outputPrice.toString());
        }
    }

    init(config: LLMProviderConfig): void {
        this.updateSettings({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            modelId: config.modelId,
            temperature: config.temperature,
            inputPrice: config.inputPrice,
            outputPrice: config.outputPrice
        });
        this.refreshSettings();
    }

    refreshSettings(): void {
        this.loadSettings();
    }

    isConfigured(): boolean {
        return !!this.apiKey().trim() && !!this.baseUrl().trim();
    }

    getCapabilities(): LLMProviderCapabilities {
        return {
            supportsContextCaching: false,
            supportsThinking: false,
            supportsStructuredOutput: true,
            isLocalProvider: false
        };
    }

    getAvailableModels(): LLMModelDefinition[] {
        return [
            {
                id: this.modelId(),
                name: `OpenAI: ${this.modelId()}`,
                getRates: () => ({
                    input: this.inputPrice(),
                    output: this.outputPrice()
                })
            }
        ];
    }

    getDefaultModelId(): string {
        return this.modelId();
    }

    getModelId(): string {
        return this.modelId();
    }

    saveConfig(config: LLMProviderConfig): void {
        if (config.baseUrl) localStorage.setItem('openai_base_url', config.baseUrl);
        if (config.apiKey) localStorage.setItem('openai_api_key', config.apiKey);
        if (config.modelId) localStorage.setItem('openai_model_id', config.modelId);
        if (config.temperature !== undefined) localStorage.setItem('openai_temperature', config.temperature.toString());
        if (config.inputPrice !== undefined) localStorage.setItem('openai_input_price', config.inputPrice.toString());
        if (config.outputPrice !== undefined) localStorage.setItem('openai_output_price', config.outputPrice.toString());

        this.init(config);
    }

    getConfigFromStorage(): LLMProviderConfig {
        return {
            baseUrl: localStorage.getItem('openai_base_url') || 'https://api.openai.com/v1',
            apiKey: localStorage.getItem('openai_api_key') || '',
            modelId: localStorage.getItem('openai_model_id') || 'gpt-4o',
            temperature: parseFloat(localStorage.getItem('openai_temperature') || '0.7'),
            inputPrice: parseFloat(localStorage.getItem('openai_input_price') || '0'),
            outputPrice: parseFloat(localStorage.getItem('openai_output_price') || '0')
        };
    }

    async *generateContentStream(
        contents: LLMContent[],
        systemInstruction: string,
        config: LLMGenerateConfig
    ): AsyncGenerator<LLMStreamChunk> {
        const baseUrl = this.baseUrl();
        const apiKey = this.apiKey();

        const messages = [
            { role: 'system', content: systemInstruction },
            ...contents.map(c => ({
                role: c.role === 'model' ? 'assistant' : c.role,
                content: c.parts.map(p => p.text || '').join('\n')
            }))
        ];

        const requestBody: Record<string, unknown> = {
            model: this.modelId(),
            messages,
            stream: true,
            temperature: this.temperature(),
            stream_options: { include_usage: true },
            cache_prompt: true, // Optimizes for llama.cpp / LocalAI caching
            ...(config.responseSchema ? {
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'structured_output',
                        strict: true,
                        schema: this.prepareSchema(config.responseSchema, true)
                    }
                },
                // Top-level json_schema for some local backends (llama.cpp)
                json_schema: this.prepareSchema(config.responseSchema, true)
            } : {})
        };

        try {
            const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(requestBody),
                signal: config.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
            }

            if (!response.body) throw new Error('No response body from server.');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let isDiscardingGarbage = !!config.responseSchema;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || trimmed === 'data: [DONE]') continue;
                        if (!trimmed.startsWith('data: ')) continue;

                        try {
                            const data = JSON.parse(trimmed.slice(6));
                            const delta = data.choices?.[0]?.delta;

                            if (delta?.content) {
                                let content = delta.content;

                                // Robust JSON Scan: Discard everything until we find '{' or '"'
                                if (isDiscardingGarbage) {
                                    const matchIndex = content.search(/[{"]/);

                                    if (matchIndex !== -1) {
                                        // Found start!
                                        const char = content[matchIndex];
                                        isDiscardingGarbage = false;

                                        // If we hit a quote first, it means the brace was missed. Inject it.
                                        const prefix = char === '"' ? '{' : '';

                                        // Keep only the valid part
                                        content = prefix + content.slice(matchIndex);
                                    } else {
                                        // No valid start token in this chunk, discard entirely
                                        continue;
                                    }
                                }

                                yield { text: content };
                            }

                            // Usage tracking for official OpenAI
                            if (data.usage) {
                                yield {
                                    usageMetadata: {
                                        promptTokens: data.usage.prompt_tokens || 0,
                                        completionTokens: data.usage.completion_tokens || 0
                                    }
                                };
                            }
                            // Usage tracking for llama.cpp OpenAI-compatible servers
                            else if (data.timings) {
                                yield {
                                    usageMetadata: {
                                        promptTokens: data.timings.prompt_n || 0,
                                        completionTokens: data.timings.predicted_n || 0
                                    }
                                };
                            }
                        } catch {
                            // Partial JSON, wait for more data
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }
        } catch (error) {
            console.error('OpenAI generation failed:', error);
            throw error;
        }
    }

    async countTokens(_modelId: string, contents: LLMContent[]): Promise<number> {
        // Rough estimate for OpenAI
        const text = contents.flatMap(c => c.parts).map(p => p.text || '').join('\n');
        return Math.ceil(text.length / 4);
    }

    /**
     * Prepares the schema for strict mode:
     * 1. Removes descriptions (for cleaner local compat).
     * 2. Injects additionalProperties: false.
     * 3. Ensures all properties are required.
     */
    private prepareSchema(schema: unknown, strictMode: boolean): object {
        if (!schema || typeof schema !== 'object') return schema as object;

        if (Array.isArray(schema)) {
            return schema.map(item => this.prepareSchema(item, strictMode));
        }

        const processed: Record<string, unknown> = {};
        const input = schema as Record<string, unknown>;

        // Copy and recurse
        for (const [key, value] of Object.entries(input)) {
            if (key === 'description') continue;
            if (value !== null && typeof value === 'object') {
                processed[key] = this.prepareSchema(value, strictMode);
            } else {
                processed[key] = value;
            }
        }

        // Apply strict requirements to Objects
        if (strictMode && processed['type'] === 'object') {
            processed['additionalProperties'] = false;

            // OpenAI Strict Mode requires all properties to be in the 'required' array
            const props = processed['properties'] as Record<string, unknown> | undefined;
            if (props) {
                processed['required'] = Object.keys(props);
            }
        }

        return processed;
    }
}
