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

interface LlamaResponse {
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
        prompt_per_second?: number;
        predicted_per_second?: number;
    };
    prompt_progress?: {
        total: number;
        processed: number;
        cache: number;
    };
}

/**
 * LlamaV2Service - Optimized llama.cpp Provider
 * Uses OpenAI-compatible /v1/chat/completions to support:
 * 1. Native Chat Templates (handled by server)
 * 2. Thinking/Reasoning (via reasoning_content)
 * 3. GBNF with Thinking (server handles phase transition)
 */
@Injectable({
    providedIn: 'root'
})
export class LlamaV2Service implements LLMProvider {
    readonly providerName = 'llama.cpp'; // Use same name to replace legacy LlamaService in registry
    settingsComponent?: Type<LLMSettingsComponent>;

    private baseUrl = signal('http://localhost:8080');
    private modelId = signal('local-model');
    private temperature = signal<number | undefined>(undefined);
    private frequencyPenalty = signal<number | undefined>(undefined);
    private presencePenalty = signal<number | undefined>(undefined);
    private inputPrice = signal<number | undefined>(undefined);
    private outputPrice = signal<number | undefined>(undefined);
    private cachedPrice = signal<number | undefined>(undefined);
    private topP = signal<number | undefined>(undefined);
    private topK = signal<number | undefined>(undefined);
    private minP = signal<number | undefined>(undefined);
    private repetitionPenalty = signal<number | undefined>(undefined);
    private enableThinking = signal<boolean>(false);
    private reasoningEffort = signal<string>('low');

    // Dynamic props from server
    private serverChatTemplate = signal<string | null>(null);

    init(config: LLMProviderConfig): void {
        const cleanStr = (val: unknown) => (typeof val === 'string' && val.trim() === '') ? undefined : val as number;

        if (config.baseUrl) {
            this.baseUrl.set(config.baseUrl.replace(/\/$/, ''));
        }
        if (config.modelId !== undefined) {
            this.modelId.set((typeof config.modelId === 'string' && config.modelId.trim() === '') ? 'local-model' : config.modelId);
        }
        if (config.temperature !== undefined) {
            this.temperature.set(cleanStr(config.temperature));
        }
        if (config.frequencyPenalty !== undefined) {
            this.frequencyPenalty.set(cleanStr(config.frequencyPenalty));
        }
        if (config.presencePenalty !== undefined) {
            this.presencePenalty.set(cleanStr(config.presencePenalty));
        }
        if (config.inputPrice !== undefined) {
            this.inputPrice.set(cleanStr(config.inputPrice));
        }
        if (config.outputPrice !== undefined) {
            this.outputPrice.set(cleanStr(config.outputPrice));
        }
        if (config.cachedPrice !== undefined) {
            this.cachedPrice.set(cleanStr(config.cachedPrice));
        }

        if (config.topP !== undefined) {
            this.topP.set(cleanStr(config.topP));
        }
        if (config.topK !== undefined) {
            this.topK.set(cleanStr(config.topK));
        }
        if (config.minP !== undefined) {
            this.minP.set(cleanStr(config.minP));
        }
        if (config.repetitionPenalty !== undefined) {
            this.repetitionPenalty.set(cleanStr(config.repetitionPenalty));
        }
        if (config.enableThinking !== undefined) {
            this.enableThinking.set(config.enableThinking);
        }
        if (config.reasoningEffort !== undefined) {
            this.reasoningEffort.set(config.reasoningEffort);
        }

        const settings = config.additionalSettings || {};
        if (settings['topP'] !== undefined) {
            this.topP.set(cleanStr(settings['topP']));
        }
        if (settings['topK'] !== undefined) {
            this.topK.set(cleanStr(settings['topK']));
        }
        if (settings['minP'] !== undefined) {
            this.minP.set(cleanStr(settings['minP']));
        }
        if (settings['repetitionPenalty'] !== undefined) {
            this.repetitionPenalty.set(cleanStr(settings['repetitionPenalty']));
        }
        if (settings['enableThinking'] !== undefined) {
            this.enableThinking.set(settings['enableThinking'] as boolean);
        }
        if (settings['reasoningEffort'] !== undefined) {
            this.reasoningEffort.set(settings['reasoningEffort'] as string);
        }

        // Proactively fetch props to identify model and template
        this.fetchProps();
    }
    saveConfig(config: LLMProviderConfig): void {
        const setOrRemove = (key: string, val: unknown) => {
            if (val !== undefined && val !== null) localStorage.setItem(key, String(val));
            else localStorage.removeItem(key);
        };

        if (config.baseUrl) localStorage.setItem('llama_base_url', config.baseUrl);
        if (config.modelId) localStorage.setItem('llama_model_id', config.modelId);
        setOrRemove('llama_temperature', config.temperature);
        setOrRemove('llama_frequency_penalty', config.frequencyPenalty);
        setOrRemove('llama_presence_penalty', config.presencePenalty);
        setOrRemove('llama_input_price', config.inputPrice);
        setOrRemove('llama_output_price', config.outputPrice);
        setOrRemove('llama_cached_price', config.cachedPrice);
        setOrRemove('llama_top_p', config.topP);
        setOrRemove('llama_top_k', config.topK);
        setOrRemove('llama_min_p', config.minP);
        setOrRemove('llama_repetition_penalty', config.repetitionPenalty);
        setOrRemove('llama_enable_thinking', config.enableThinking);
        setOrRemove('llama_reasoning_effort', config.reasoningEffort);

        // Also save from additionalSettings if present
        const settings = config.additionalSettings || {};
        setOrRemove('llama_top_p', settings['topP'] ?? config.topP);
        setOrRemove('llama_top_k', settings['topK'] ?? config.topK);
        setOrRemove('llama_min_p', settings['minP'] ?? config.minP);
        setOrRemove('llama_repetition_penalty', settings['repetitionPenalty'] ?? config.repetitionPenalty);
        setOrRemove('llama_enable_thinking', settings['enableThinking'] ?? config.enableThinking);
        setOrRemove('llama_reasoning_effort', settings['reasoningEffort'] ?? config.reasoningEffort);

        this.init(config);
    }

    getConfigFromStorage(): LLMProviderConfig {
        const getNum = (key: string) => {
            const val = localStorage.getItem(key);
            return val ? parseFloat(val) : undefined;
        };
        const getBool = (key: string) => localStorage.getItem(key) === 'true';
        const getStr = (key: string) => localStorage.getItem(key) || undefined;

        const baseConfig: LLMProviderConfig = {
            baseUrl: localStorage.getItem('llama_base_url') || 'http://localhost:8080',
            modelId: localStorage.getItem('llama_model_id') || 'local-model',
            temperature: getNum('llama_temperature'),
            frequencyPenalty: getNum('llama_frequency_penalty'),
            presencePenalty: getNum('llama_presence_penalty'),
            inputPrice: getNum('llama_input_price'),
            outputPrice: getNum('llama_output_price'),
            cachedPrice: getNum('llama_cached_price'),
            topP: getNum('llama_top_p'),
            topK: getNum('llama_top_k'),
            minP: getNum('llama_min_p'),
            repetitionPenalty: getNum('llama_repetition_penalty'),
            enableThinking: localStorage.getItem('llama_enable_thinking') ? getBool('llama_enable_thinking') : undefined,
            reasoningEffort: getStr('llama_reasoning_effort'),
        };

        // Populate additionalSettings as well for backward compatibility / flexibility
        baseConfig.additionalSettings = {
            topP: baseConfig.topP,
            topK: baseConfig.topK,
            minP: baseConfig.minP,
            repetitionPenalty: baseConfig.repetitionPenalty,
            enableThinking: baseConfig.enableThinking,
            reasoningEffort: baseConfig.reasoningEffort
        };

        return baseConfig;
    }
    private async fetchProps() {
        try {
            const response = await fetch(`${this.baseUrl()}/props`);
            if (response.ok) {
                const data = await response.json();
                if (data.chat_template) {
                    this.serverChatTemplate.set(data.chat_template);
                }
                // If modelId is still default or not set, use model_alias from server
                if (data.model_alias && (this.modelId() === 'local-model' || !this.modelId())) {
                    this.modelId.set(data.model_alias);
                    console.log(`[LlamaV2] Model ID updated from server: ${data.model_alias}`);
                }
            }
        } catch (e) {
            console.warn('[LlamaV2] Failed to fetch server props', e);
        }
    }

    isConfigured(): boolean {
        return !!this.baseUrl().trim();
    }

    getCapabilities(): LLMProviderCapabilities {
        return {
            supportsContextCaching: true, // Supported via n_keep + cache_prompt
            supportsThinking: true,      // Supported via OpenAI reasoning_content
            supportsStructuredOutput: true,
            isLocalProvider: true,
            supportsSpeedMetrics: true
        };
    }

    getAvailableModels(): LLMModelDefinition[] {
        return [
            {
                id: this.modelId(),
                name: `Local Model (${this.modelId()})`,
                getRates: () => ({
                    input: this.inputPrice() ?? 0,
                    output: this.outputPrice() ?? 0,
                    cached: this.cachedPrice() ?? 0,
                    cacheStorage: 0
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

        // Ensure we have server info before starting if we're still on default
        if (this.modelId() === 'local-model') {
            await this.fetchProps();
        }

        // Map contents to OpenAI format
        const messages = [
            ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
            ...contents.map(c => ({
                role: c.role === 'model' ? 'assistant' : c.role,
                content: c.parts.map(p => p.text || '').join('\n')
            }))
        ];

        // Optimal n_keep calculation
        let n_keep = -1;
        try {
            if (systemInstruction) {
                n_keep = await this.countTokens(this.modelId(), [
                    { role: 'system', parts: [{ text: systemInstruction }] }
                ]);
            }
        } catch (e) {
            console.warn('[LlamaV2] Failed to calculate n_keep', e);
        }

        const preparedSchema = config.responseSchema ? this.prepareSchema(config.responseSchema) : null;

        // Map reasoning effort to token budget (llama.cpp uses reasoning_budget, not reasoning_effort)
        const reasoningBudgetMap: Record<string, number> = { low: 512, medium: 2048, high: 8192 };
        const thinkingEnabled = this.enableThinking();
        const reasoningBudget = thinkingEnabled
            ? (reasoningBudgetMap[this.reasoningEffort()] ?? 2048)
            : 0;

        const requestBody: Record<string, unknown> = this.cleanObject({
            model: this.modelId(),
            messages,
            stream: true,
            temperature: this.temperature(),
            frequency_penalty: this.frequencyPenalty(),
            presence_penalty: this.presencePenalty(),
            top_p: this.topP(),
            top_k: this.topK(),
            min_p: this.minP(),
            repetition_penalty: this.repetitionPenalty(),
            stream_options: { include_usage: true },
            return_progress: true,
            cache_prompt: true,
            n_keep: n_keep,
            ...(config.responseSchema ? {
                // Combined style for maximum server compatibility
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'structured_output',
                        strict: true,
                        schema: preparedSchema
                    }
                },
                // Some versions look directly at the root json_schema
                json_schema: {
                    name: 'structured_output',
                    strict: true,
                    schema: preparedSchema
                }
            } : {}),
            // llama.cpp native: enable_thinking must be inside chat_template_kwargs
            chat_template_kwargs: {
                enable_thinking: thinkingEnabled
            },
            reasoning_budget: reasoningBudget
        });

        try {
            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: config.signal
            });

            if (!response.ok) {
                throw new Error(`llama.cpp OAI error (${response.status}): ${await response.text()}`);
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
                            const data = JSON.parse(trimmed.slice(6)) as LlamaResponse;
                            const delta = data.choices?.[0]?.delta;

                            // Handle standard content
                            if (delta?.content) {
                                yield { text: delta.content };
                            }

                            // Handle explicit thinking content (standard OAI field)
                            if (delta?.reasoning_content) {
                                yield { text: delta.reasoning_content, thought: true };
                            }

                            // Robust Thinking Detection: Some llama.cpp templates put thinking inside <|channel|>analysis
                            if (delta?.content && (delta.content.includes('<|channel|>analysis') || delta.content.includes('<|start|>assistant<|channel|>analysis'))) {
                                // This is thinking! Since we are yielding text, we should ideally mark it.
                                // But if it's mixed in content, we just let it be or try to mark it.
                                // For now, the JSON Scan above will naturally skip it if it's before '{'.
                                console.log('[LlamaV2] Internal thinking detected in content stream');
                            }

                            // Usage and timings
                            if (data.usage || data.timings || data.prompt_progress) {
                                const usage = data.usage;
                                const timings = data.timings;
                                const progress = data.prompt_progress;

                                yield {
                                    usageMetadata: {
                                        // Prefer timings for more detail (cached vs active prompt)
                                        prompt: (timings?.prompt_n ?? usage?.prompt_tokens) || 0,
                                        candidates: (timings?.predicted_n ?? usage?.completion_tokens) || 0,
                                        cached: (timings?.cache_n ?? usage?.prompt_tokens_details?.cached_tokens) || 0,
                                        promptSpeed: timings?.prompt_per_second,
                                        completionSpeed: timings?.predicted_per_second,
                                        promptProgress: progress && progress.total > 0 ? (progress.processed / progress.total) : undefined
                                    }
                                };
                            }
                        } catch { /* Partial chunks */ }
                    }
                }
            } finally {
                reader.releaseLock();
            }

        } catch (error) {
            console.error('LlamaV2 generation failed:', error);
            throw error;
        }
    }

    async countTokens(_modelId: string, contents: LLMContent[]): Promise<number> {
        const text = contents.flatMap(c => c.parts).map(p => p.text || '').join('\n');
        if (!text) return 0;
        try {
            const response = await fetch(`${this.baseUrl()}/tokenize`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: text })
            });
            if (response.ok) {
                const data = await response.json();
                return Array.isArray(data.tokens) ? data.tokens.length : 0;
            }
        } catch (e) {
            console.warn('[LlamaV2] Tokenization failed, using fallback', e);
        }
        return Math.ceil(text.length / 3.5);
    }

    /**
     * Robust schema preparation for Structured Outputs.
     * 1. Removes non-structural fields (title, description, etc.)
     * 2. Forces additionalProperties: false
     * 3. Ensures all properties are in 'required' array
     */
    private prepareSchema(schema: object): Record<string, unknown> {
        if (!schema || typeof schema !== 'object') return schema as Record<string, unknown>;

        const result = JSON.parse(JSON.stringify(schema)); // Clone

        const process = (obj: Record<string, unknown>) => {
            if (obj['type'] === 'object' && obj['properties']) {
                // Mandatory for strict mode:
                obj['additionalProperties'] = false;
                obj['required'] = Object.keys(obj['properties'] as object);

                const properties = obj['properties'] as Record<string, Record<string, unknown>>;
                for (const key in properties) {
                    process(properties[key]);
                }
            } else if (obj['type'] === 'array' && obj['items']) {
                process(obj['items'] as Record<string, unknown>);
            }

            // Strip metadata
            delete obj['title'];
            delete obj['description'];
            delete obj['default'];
            delete obj['$schema'];
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
