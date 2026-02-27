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

interface OpenAIResponse {
    choices?: {
        delta?: {
            content?: string;
            reasoning_content?: string;
        };
    }[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: {
            cached_tokens?: number;
        };
    };
    timings?: {
        prompt_n?: number;
        predicted_n?: number;
        cache_n?: number;
    };
}

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
    private temperature = signal<number | undefined>(undefined);
    private frequencyPenalty = signal<number | undefined>(undefined);
    private presencePenalty = signal<number | undefined>(undefined);
    private inputPrice = signal<number | undefined>(undefined);
    private outputPrice = signal<number | undefined>(undefined);

    init(config: LLMProviderConfig): void {
        if (config.baseUrl) {
            this.baseUrl.set(config.baseUrl.replace(/\/$/, ''));
        }
        if (config.apiKey !== undefined) {
            this.apiKey.set(config.apiKey);
        }
        if (config.modelId) {
            this.modelId.set(config.modelId);
        }
        if (config.temperature !== undefined) {
            this.temperature.set(config.temperature);
        }
        if (config.frequencyPenalty !== undefined) {
            this.frequencyPenalty.set(config.frequencyPenalty);
        }
        if (config.presencePenalty !== undefined) {
            this.presencePenalty.set(config.presencePenalty);
        }
        if (config.inputPrice !== undefined) {
            this.inputPrice.set(config.inputPrice);
        }
        if (config.outputPrice !== undefined) {
            this.outputPrice.set(config.outputPrice);
        }
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
                    input: this.inputPrice() ?? 0,
                    output: this.outputPrice() ?? 0
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

        const requestBody: Record<string, unknown> = this.cleanObject({
            model: this.modelId(),
            messages,
            stream: true,
            temperature: this.temperature(),
            frequency_penalty: this.frequencyPenalty(),
            presence_penalty: this.presencePenalty(),
            stream_options: { include_usage: true },
            ...(config.responseSchema ? {
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'structured_output',
                        strict: true,
                        schema: this.prepareSchema(config.responseSchema)
                    }
                }
            } : {})
        });

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
                            const data = JSON.parse(trimmed.slice(6)) as OpenAIResponse;
                            const delta = data.choices?.[0]?.delta;

                            if (delta?.content) {
                                yield { text: delta.content };
                            }

                            // Handle explicit thinking content (if server supports it)
                            if (delta?.reasoning_content) {
                                yield { text: delta.reasoning_content, thought: true };
                            }

                            // Usage tracking
                            if (data.usage || data.timings) {
                                const usage = data.usage;
                                const timings = data.timings;
                                yield {
                                    usageMetadata: {
                                        prompt: (usage?.prompt_tokens ?? timings?.prompt_n) || 0,
                                        candidates: (usage?.completion_tokens ?? timings?.predicted_n) || 0,
                                        cached: (usage?.prompt_tokens_details?.cached_tokens ?? timings?.cache_n) || 0
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
    saveConfig(config: LLMProviderConfig): void {
        if (config.baseUrl) localStorage.setItem('openai_base_url', config.baseUrl);
        if (config.apiKey) localStorage.setItem('openai_api_key', config.apiKey);
        if (config.modelId) localStorage.setItem('openai_model_id', config.modelId);
        if (config.temperature !== undefined && config.temperature !== null) localStorage.setItem('openai_temperature', config.temperature.toString());
        else localStorage.removeItem('openai_temperature');

        if (config.frequencyPenalty !== undefined && config.frequencyPenalty !== null) localStorage.setItem('openai_frequency_penalty', config.frequencyPenalty.toString());
        else localStorage.removeItem('openai_frequency_penalty');

        if (config.presencePenalty !== undefined && config.presencePenalty !== null) localStorage.setItem('openai_presence_penalty', config.presencePenalty.toString());
        else localStorage.removeItem('openai_presence_penalty');

        if (config.inputPrice !== undefined && config.inputPrice !== null) localStorage.setItem('openai_input_price', config.inputPrice.toString());
        else localStorage.removeItem('openai_input_price');

        if (config.outputPrice !== undefined && config.outputPrice !== null) localStorage.setItem('openai_output_price', config.outputPrice.toString());
        else localStorage.removeItem('openai_output_price');

        this.init(config);
    }

    getConfigFromStorage(): LLMProviderConfig {
        const temperature = localStorage.getItem('openai_temperature');
        const freqPenalty = localStorage.getItem('openai_frequency_penalty');
        const presPenalty = localStorage.getItem('openai_presence_penalty');
        const inPrice = localStorage.getItem('openai_input_price');
        const outPrice = localStorage.getItem('openai_output_price');

        return {
            baseUrl: localStorage.getItem('openai_base_url') || 'https://api.openai.com/v1',
            apiKey: localStorage.getItem('openai_api_key') || '',
            modelId: localStorage.getItem('openai_model_id') || 'gpt-4o',
            temperature: temperature ? parseFloat(temperature) : undefined,
            frequencyPenalty: freqPenalty ? parseFloat(freqPenalty) : undefined,
            presencePenalty: presPenalty ? parseFloat(presPenalty) : undefined,
            inputPrice: inPrice ? parseFloat(inPrice) : undefined,
            outputPrice: outPrice ? parseFloat(outPrice) : undefined
        };
    }
    /**
     * Robust schema preparation for Structured Outputs.
     * 1. Removes non-structural fields (title, description, etc.)
     * 2. Forces additionalProperties: false
     * 3. Ensures all properties are in 'required' array
     */
    private prepareSchema(schema: any): any {
        if (!schema || typeof schema !== 'object') return schema;

        const result = JSON.parse(JSON.stringify(schema)); // Clone

        const process = (obj: any) => {
            if (obj.type === 'object' && obj.properties) {
                // Mandatory for strict mode:
                obj.additionalProperties = false;
                obj.required = Object.keys(obj.properties);

                for (const key in obj.properties) {
                    process(obj.properties[key]);
                }
            } else if (obj.type === 'array' && obj.items) {
                process(obj.items);
            }

            // Strip metadata
            delete obj.title;
            delete obj.description;
            delete obj.default;
            delete obj.$schema;
        };

        process(result);
        return result;
    }

    /**
     * Filters out null, undefined, and empty string properties from an object.
     */
    private cleanObject(obj: Record<string, number | string | boolean | object | undefined | null>): Record<string, unknown> {
        return Object.fromEntries(
            Object.entries(obj).filter(([, v]) => {
                if (v === null || v === undefined) return false;
                if (typeof v === 'string' && v.trim() === '') return false;
                return true;
            })
        );
    }
}
