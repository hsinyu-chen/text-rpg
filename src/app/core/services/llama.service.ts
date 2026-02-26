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
 * LlamaService - llama.cpp Server Provider (With Schema Injection Shim)
 * * Includes "Schema Injection" logic to force local models to follow 
 * complex JSON structures defined in GameEngine.
 */
@Injectable({
    providedIn: 'root'
})
export class LlamaService implements LLMProvider {
    readonly providerName = 'llama.cpp';
    settingsComponent?: Type<LLMSettingsComponent>;

    private baseUrl = signal('http://localhost:8080');
    private modelId = signal('local-model');
    private temperature = signal(0.5);
    private inputPrice = signal(0);
    private outputPrice = signal(0);

    constructor() {
        // Load settings from localStorage on initialization
        this.loadSettings();
    }

    /**
     * Get the current base URL from localStorage
     * This ensures we always use the latest value
     */
    private getBaseUrlFromStorage(): string {
        const savedUrl = localStorage.getItem('llama_base_url');
        if (savedUrl) {
            return savedUrl.replace(/\/$/, '');
        }
        return 'http://localhost:8080';
    }

    /**
     * Get the current model ID from localStorage
     * This ensures we always use the latest value
     */
    private getModelIdFromStorage(): string {
        const savedModelId = localStorage.getItem('llama_model_id');
        if (savedModelId) {
            return savedModelId;
        }
        return 'local-model';
    }

    /**
     * Load settings from localStorage
     */
    private loadSettings(): void {
        this.baseUrl.set(this.getBaseUrlFromStorage());
        this.modelId.set(this.getModelIdFromStorage());
        const savedTemp = localStorage.getItem('llama_temperature');
        if (savedTemp) {
            this.temperature.set(parseFloat(savedTemp));
        }
        this.inputPrice.set(parseFloat(localStorage.getItem('llama_input_price') || '0'));
        this.outputPrice.set(parseFloat(localStorage.getItem('llama_output_price') || '0'));
    }

    /**
     * Refresh settings from localStorage
     */
    refreshSettings(): void {
        this.baseUrl.set(localStorage.getItem('llama_base_url') || 'http://localhost:8080');
        this.modelId.set(localStorage.getItem('llama_model_id') || 'local-model');
        const savedTemp = localStorage.getItem('llama_temperature');
        if (savedTemp) {
            this.temperature.set(parseFloat(savedTemp));
        }
        this.inputPrice.set(parseFloat(localStorage.getItem('llama_input_price') || '0'));
        this.outputPrice.set(parseFloat(localStorage.getItem('llama_output_price') || '0'));
    }

    /**
     * Update settings from external configuration
     * @param config LLMProviderConfig containing baseUrl and modelId
     */
    private updateSettings(settings: { baseUrl?: string; modelId?: string; temperature?: number, inputPrice?: number, outputPrice?: number }): void {
        if (settings.baseUrl) {
            const cleanedUrl = settings.baseUrl.replace(/\/$/, '');
            this.baseUrl.set(cleanedUrl);
            localStorage.setItem('llama_base_url', cleanedUrl);
        }
        if (settings.modelId) {
            this.modelId.set(settings.modelId);
            localStorage.setItem('llama_model_id', settings.modelId);
        }
        if (settings.temperature !== undefined) {
            this.temperature.set(settings.temperature);
            localStorage.setItem('llama_temperature', settings.temperature.toString());
        }
        if (settings.inputPrice !== undefined) {
            this.inputPrice.set(settings.inputPrice);
            localStorage.setItem('llama_input_price', settings.inputPrice.toString());
        }
        if (settings.outputPrice !== undefined) {
            this.outputPrice.set(settings.outputPrice);
            localStorage.setItem('llama_output_price', settings.outputPrice.toString());
        }
    }

    init(config: LLMProviderConfig): void {
        this.updateSettings({
            baseUrl: config.baseUrl,
            modelId: config.modelId,
            temperature: config.temperature,
            inputPrice: config.inputPrice,
            outputPrice: config.outputPrice
        });
        // Also refresh from localStorage to ensure latest values are used
        this.refreshSettings();
    }

    isConfigured(): boolean {
        return !!this.baseUrl().trim();
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
                id: this.modelId(),
                name: `Local Model (${this.modelId()})`,
                getRates: () => ({
                    input: this.inputPrice(),
                    output: this.outputPrice(),
                    cached: 0,
                    cacheStorage: 0
                })
            }
        ];
    }

    getDefaultModelId(): string {
        return this.getModelIdFromStorage();
    }

    getModelId(): string {
        return this.modelId();
    }

    saveConfig(config: LLMProviderConfig): void {
        if (config.baseUrl) localStorage.setItem('llama_base_url', config.baseUrl);
        if (config.modelId) localStorage.setItem('llama_model_id', config.modelId);
        if (config.temperature !== undefined) localStorage.setItem('llama_temperature', config.temperature.toString());
        if (config.inputPrice !== undefined) localStorage.setItem('llama_input_price', config.inputPrice.toString());
        if (config.outputPrice !== undefined) localStorage.setItem('llama_output_price', config.outputPrice.toString());

        this.init(config);
    }

    getConfigFromStorage(): LLMProviderConfig {
        return {
            baseUrl: localStorage.getItem('llama_base_url') || 'http://localhost:8080',
            modelId: localStorage.getItem('llama_model_id') || 'local-model',
            temperature: parseFloat(localStorage.getItem('llama_temperature') || '0.5'),
            inputPrice: parseFloat(localStorage.getItem('llama_input_price') || '0'),
            outputPrice: parseFloat(localStorage.getItem('llama_output_price') || '0')
        };
    }
    async *generateContentStream(
        contents: LLMContent[],
        systemInstruction: string,
        config: LLMGenerateConfig
    ): AsyncGenerator<LLMStreamChunk> {
        const baseUrl = this.baseUrl();

        const systemPart = `<|start|>system<|message|>Reasoning: low\n\n${systemInstruction || ''}<|end|>`;

        let historyPart = '';
        for (const content of contents) {
            const role = content.role === 'model' ? 'assistant' : content.role;
            const text = content.parts.map(p => p.text || '').filter(t => t).join('\n');
            if (role === 'assistant') {
                historyPart += `<|start|>assistant<|channel|>final<|message|>${text}<|end|>`;
            } else {
                historyPart += `<|start|>${role}<|message|>${text}<|end|>`;
            }
        }
        historyPart += `<|start|>assistant<|channel|>final<|message|>{`;

        const prompt = systemPart + historyPart;

        let n_keep = -1;
        try {
            const sysTokens = await this.countTokens(this.modelId(), [{ role: 'system', parts: [{ text: systemPart }] }]);
            n_keep = sysTokens;
        } catch (e) {
            console.warn('[LlamaService] Failed to calculate n_keep, defaulting to -1 (Keep All)', e);
        }

        const requestBody = {
            prompt,
            stream: true,
            n_predict: -1,
            temperature: this.temperature(),
            repeat_penalty: 1.1,
            stop: [
                "\nUser:",
                "\nSystem:",
                "\n\n\n",
                "</s>",
                "<|eot_id|>",
                "<|im_end|>",
                "<|end|>"
            ],
            cache_prompt: true,
            n_keep: n_keep,
            return_progress: true,
            ...(config.responseSchema ? {
                json_schema: this.cleanSchema(config.responseSchema)
            } : {})
        };

        if (config.responseSchema) {
            console.log(`[LlamaService] Native Schema active. n_keep=${n_keep}.`);
        } else {
            console.log('[LlamaService] Schema not provided, running in free-text mode.');
        }

        try {
            const response = await fetch(`${baseUrl}/completion`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: config.signal
            });

            if (!response.ok) {
                throw new Error(`llama.cpp error (${response.status}): ${await response.text()}`);
            }

            if (!response.body) throw new Error('No response body from server.');

            // No manual yield of '{' here because llama.cpp's json_schema 
            // will generate it as the first token of the output.

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

                        try {
                            const parsed = JSON.parse(data);

                            if (parsed.content) {
                                yield { text: parsed.content };
                            }

                            if (parsed.stop) {
                                yield { finishReason: 'stop' };
                            }

                            // Handle Prompt Processing Progress
                            if (parsed.prompt_progress) {
                                const total = parsed.prompt_progress.total || 1;
                                const processed = parsed.prompt_progress.processed || 0;
                                yield {
                                    usageMetadata: {
                                        prompt: total,
                                        candidates: 0,
                                        cached: 0,
                                        promptProgress: processed / total
                                    }
                                };
                            }

                            // Native llama.cpp usage and timings (final chunk usually)
                            if (parsed.tokens_predicted || parsed.tokens_evaluated || parsed.timings) {
                                yield {
                                    usageMetadata: {
                                        prompt: parsed.tokens_evaluated || 0,
                                        candidates: parsed.tokens_predicted || 0,
                                        cached: parsed.tokens_cached || 0,
                                        promptSpeed: parsed.timings?.prompt_per_second,
                                        completionSpeed: parsed.timings?.predicted_per_second,
                                        totalDuration: (parsed.timings?.predicted_ms || 0) + (parsed.timings?.prompt_ms || 0)
                                    }
                                };
                            }
                        } catch { /* Ignore partial chunks */ }
                    }
                }
            } finally {
                reader.releaseLock();
            }

        } catch (error) {
            console.error('Llama generation failed:', error);
            if (error instanceof TypeError && error.message?.includes('fetch')) {
                throw new Error(`Connection Failed: Check if llama.cpp server is running at ${baseUrl}`);
            }
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
        } catch { /* Ignore token counting errors */ }
        return Math.ceil(text.length / 3.5);
    }

    // =========================================================================
    // Helper Methods
    // =========================================================================

    // NOTE: toNativePrompt removed (inlined in generateContentStream for n_keep calculation)

    /**
     * Recursively removes 'description' keys from a JSON schema.
     * llama.cpp's internal schema-to-gbnf converter can fail on non-structural fields.
     */
    private cleanSchema(schema: object): object {
        if (!schema || typeof schema !== 'object') return schema;

        if (Array.isArray(schema)) {
            return schema.map(item => this.cleanSchema(item));
        }

        const cleaned: Record<string, object | string | number | boolean | null> = {};
        const entries = Object.entries(schema);

        for (const [key, value] of entries) {
            if (key === 'description') continue;
            if (value !== null && typeof value === 'object') {
                cleaned[key] = this.cleanSchema(value);
            } else {
                cleaned[key] = value;
            }
        }
        return cleaned;
    }
}