import { Injectable, signal, Type } from '@angular/core';
import {
    LLMProvider,
    LLMProviderCapabilities,
    LLMProviderConfig,
    LLMContent,
    LLMGenerateConfig,
    LLMStreamChunk,
    LLMModelDefinition,
    LLMSettingsComponent,
    LLMCacheInfo
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
        time_ms?: number;
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
    private enableSaveSlot = signal<boolean>(false);

    // Dynamic props from server
    private serverChatTemplate = signal<string | null>(null);
    private serverContextSize = signal<number | null>(null);

    // Per-session cache of slot metadata (token counts, expiry stub) keyed by filename.
    // Purely informational — the server's slot is re-restored every validation turn
    // to guarantee KV correctness even if the server was restarted mid-session.
    private sessionSlotInfo = new Map<string, LLMCacheInfo>();
    private readonly slotId = 0;
    // When createCache determines no on-disk slot exists yet, we defer the save to after
    // the next real generation. Priming with a fake message shape was unreliable because
    // the chat template renders [system, user:"."] and [system, ...history, user:latest]
    // as different token sequences — prefix match on the saved slot then collapses to
    // just the BOS header tokens, wasting the slot. Saving *after* a real request
    // guarantees the persisted tokens exactly equal what a resumed session will send.
    private pendingSaveFilename: string | null = null;
    // Content hash of the state we're about to save; written alongside the .bin
    // so a later createCache can tell whether the on-disk slot is stale vs fresh.
    private pendingSaveHash: string | null = null;
    private pendingSaveHashKey: string | null = null;

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
        if (config.enableCache !== undefined) {
            this.enableSaveSlot.set(!!config.enableCache);
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
        setOrRemove('llama_enable_save_slot', config.enableCache);

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
            enableCache: localStorage.getItem('llama_enable_save_slot') === 'true'
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
                // Context window — modern llama.cpp nests this under default_generation_settings.
                // Fall back to root n_ctx for older builds.
                const nCtx = data?.default_generation_settings?.n_ctx ?? data?.n_ctx;
                if (typeof nCtx === 'number' && nCtx > 0) {
                    this.serverContextSize.set(nCtx);
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
            supportsContextCaching: true, // Supported via slot save/restore + n_keep + cache_prompt
            supportsThinking: true,      // Supported via OpenAI reasoning_content
            supportsStructuredOutput: true,
            isLocalProvider: true,
            supportsSpeedMetrics: true,
            // llama.cpp caches by prefix match (not by content reference),
            // so KB must still be sent in the prompt on every request.
            cacheBakesContent: false
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

    getContextSize(): number | null {
        return this.serverContextSize();
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

                                const cachedTokens = (timings?.cache_n ?? usage?.prompt_tokens_details?.cached_tokens ?? progress?.cache) || 0;
                                // llama.cpp's timings.prompt_n counts only freshly-evaluated tokens; total = prompt_n + cache_n.
                                // OpenAI's usage.prompt_tokens is already the total.
                                const promptTotal = timings?.prompt_n != null
                                    ? (timings.prompt_n + cachedTokens)
                                    : (usage?.prompt_tokens ?? progress?.total ?? 0);

                                yield {
                                    usageMetadata: {
                                        prompt: promptTotal,
                                        candidates: (timings?.predicted_n ?? usage?.completion_tokens) || 0,
                                        cached: cachedTokens,
                                        promptSpeed: timings?.prompt_per_second ?? (progress?.time_ms ? (progress.processed / (progress.time_ms / 1000)) : undefined),
                                        completionSpeed: timings?.predicted_per_second,
                                        promptProgress: progress && progress.total > 0 ? (progress.processed / progress.total) : undefined,
                                        promptTotal: progress?.total,
                                        promptProcessed: progress?.processed,
                                        promptCache: progress?.cache
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
        } finally {
            // If createCache queued a slot save (file didn't exist on disk yet),
            // persist the slot now that the real request has populated it. This
            // saves the actual chat-template-rendered token sequence, so the next
            // session can restore it and get a real prefix match.
            if (!this.pendingSaveFilename) {
                console.log('[LlamaV2] Post-gen: no pending slot save (either disabled, or slot already valid for current KB/system/model).');
            } else if (config.signal?.aborted) {
                console.log('[LlamaV2] Post-gen: skipping slot save (request aborted).');
                this.pendingSaveFilename = null;
                this.pendingSaveHash = null;
                this.pendingSaveHashKey = null;
            } else {
                const filename = this.pendingSaveFilename;
                const hash = this.pendingSaveHash;
                const hashKey = this.pendingSaveHashKey;
                this.pendingSaveFilename = null;
                this.pendingSaveHash = null;
                this.pendingSaveHashKey = null;
                try {
                    const saveRes = await fetch(`${baseUrl}/slots/${this.slotId}?action=save`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filename })
                    });
                    if (saveRes.ok) {
                        if (hashKey && hash) localStorage.setItem(hashKey, hash);
                        console.log(`[LlamaV2] Slot persisted after generation: ${filename}`);
                    } else {
                        console.warn(`[LlamaV2] Slot save failed: ${saveRes.status} ${await saveRes.text()}`);
                    }
                } catch (e) {
                    console.warn('[LlamaV2] Post-gen slot save failed:', e);
                }
            }
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

    // =========================================================================
    // Slot Save / Restore (maps onto LLMProvider cache interface)
    // =========================================================================

    /**
     * Derive the slot filename from the active book ID. One book → one .bin file,
     * regardless of KB/system/model changes. The slot state naturally tracks
     * whatever the current book's content is, and a stale slot is self-correcting:
     * on restore, the new request's tokens will prefix-match up to wherever the
     * old content diverges, and re-PP from there. Much simpler than content hashing,
     * and avoids orphan .bin files piling up whenever a prompt tweak changes the hash.
     */
    private deriveSlotFilename(): string {
        const safe = this.activeBookKey().replace(/[^a-zA-Z0-9_-]/g, '_');
        return `book_${safe}.bin`;
    }

    private activeBookKey(): string {
        return localStorage.getItem('last_active_book_id') || 'default';
    }

    /**
     * Hash of the content the slot would represent — used to detect whether the
     * on-disk .bin is stale relative to the current KB / system / model. When this
     * differs from the hash recorded at the last save, we queue a re-save so the
     * file refreshes automatically on the next generation.
     */
    private computeContentHash(systemInstruction: string, contents: LLMContent[], modelId: string): string {
        const kbText = contents.flatMap(c => c.parts).map(p => p.text || '').join('');
        const raw = ((kbText || '') + (modelId || '') + (systemInstruction || ''))
            .replace(/\r\n/g, '\n')
            .trim();
        let hash = 0;
        for (let i = 0; i < raw.length; i++) {
            hash = ((hash << 5) - hash) + raw.charCodeAt(i);
            hash |= 0;
        }
        return Math.abs(hash).toString(36);
    }

    /**
     * Ensure slot N is backed by a persisted .bin for this KB/system/model combo.
     * Strategy depends on whether content has changed since the last save:
     *   - Hash matches: restore the existing .bin (fast path, reuses saved KV).
     *   - Hash differs or first time: erase the slot so generation rebuilds from
     *     a clean KV. Restoring stale content would let the old KB's KV partially
     *     prefix-match the new request and potentially leak into attention, which
     *     defeats the point of updating the KB.
     * In the differs/first-time cases we queue a post-gen save so the fresh KV
     * gets persisted, overwriting the stale .bin.
     */
    async createCache(
        modelId: string,
        systemInstruction: string,
        contents: LLMContent[],
        _ttlSeconds: number
    ): Promise<LLMCacheInfo | null> {
        const filename = this.deriveSlotFilename();
        const baseUrl = this.baseUrl();
        const hashKey = `llama_slot_saved_hash_${this.activeBookKey()}`;
        const currentHash = this.computeContentHash(systemInstruction, contents, modelId);
        const lastSavedHash = localStorage.getItem(hashKey);
        const hashMatches = !!lastSavedHash && currentHash === lastSavedHash;

        let restoredTokens = 0;
        if (hashMatches) {
            // Fast path: content hasn't changed since last save, restore the .bin.
            try {
                const res = await fetch(`${baseUrl}/slots/${this.slotId}?action=restore`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename })
                });
                if (res.ok) {
                    const data = await res.json().catch(() => ({}));
                    restoredTokens = data?.n_restored ?? data?.tokens_restored ?? 0;
                    console.log(`[LlamaV2] Slot restored from disk: ${filename} (${restoredTokens} tokens)`);
                } else {
                    // .bin missing despite hash match (user deleted cache dir?) — fall through to rebuild.
                    console.warn('[LlamaV2] Hash matched but restore failed — treating as rebuild.');
                    await this.eraseSlot();
                    this.pendingSaveFilename = filename;
                    this.pendingSaveHash = currentHash;
                    this.pendingSaveHashKey = hashKey;
                }
            } catch (e) {
                console.warn('[LlamaV2] Restore attempt threw — rebuilding:', e);
                await this.eraseSlot();
                this.pendingSaveFilename = filename;
                this.pendingSaveHash = currentHash;
                this.pendingSaveHashKey = hashKey;
            }
        } else {
            // Rebuild path: content changed (or never saved). Erase slot so generation
            // starts from a clean KV — no stale prefix from the old .bin.
            await this.eraseSlot();
            this.pendingSaveFilename = filename;
            this.pendingSaveHash = currentHash;
            this.pendingSaveHashKey = hashKey;
            const reason = lastSavedHash
                ? 'KB/system/model hash changed since last save'
                : 'no prior save recorded';
            console.log(`[LlamaV2] Slot erased; will persist fresh KV after next generation (${reason}).`);
        }

        const info: LLMCacheInfo = {
            name: filename,
            displayName: filename,
            model: modelId,
            createTime: Date.now(),
            expireTime: this.farFutureExpire(),
            usageMetadata: { totalTokenCount: restoredTokens }
        };
        this.sessionSlotInfo.set(filename, info);
        return info;
    }

    private async eraseSlot(): Promise<void> {
        try {
            await fetch(`${this.baseUrl()}/slots/${this.slotId}?action=erase`, { method: 'POST' });
        } catch (e) {
            console.warn('[LlamaV2] Slot erase failed:', e);
        }
    }

    /**
     * Re-load the slot file into slot N on every validation. The previous per-session
     * short-circuit was unsafe: if the server's in-memory slot ever got cleared
     * (server restart, different model swap, another client writing to slot 0),
     * the client would falsely report "cache valid" and generation would run against
     * an empty KV — exactly the n_tokens=0 / memory_seq_rm[0,end) symptom observed.
     * Restore is idempotent, so calling it each turn is safe and guarantees slot 0
     * actually mirrors the .bin before generation starts.
     */
    async getCache(name: string): Promise<LLMCacheInfo | null> {
        try {
            const res = await fetch(`${this.baseUrl()}/slots/${this.slotId}?action=restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: name })
            });
            if (!res.ok) {
                // File missing or server rejected — treat as cache miss.
                return null;
            }
            const data = await res.json();
            const info: LLMCacheInfo = {
                name,
                displayName: name,
                model: this.modelId(),
                createTime: undefined,
                expireTime: this.farFutureExpire(),
                usageMetadata: { totalTokenCount: data?.n_restored ?? data?.tokens_restored ?? 0 }
            };
            this.sessionSlotInfo.set(name, info);
            console.log(`[LlamaV2] Slot restored: ${name} (${info.usageMetadata?.totalTokenCount ?? 0} tokens)`);
            return info;
        } catch (e) {
            console.warn('[LlamaV2] getCache restore failed:', e);
            return null;
        }
    }

    /**
     * Local slot files have no TTL. Return existing info with a refreshed far-future expire
     * so the UI countdown shows "persistent" instead of decaying to zero.
     */
    async updateCacheTTL(name: string, _ttlSeconds: number): Promise<LLMCacheInfo | null> {
        const existing = this.sessionSlotInfo.get(name);
        const info: LLMCacheInfo = existing
            ? { ...existing, expireTime: this.farFutureExpire() }
            : {
                name,
                displayName: name,
                model: this.modelId(),
                createTime: undefined,
                expireTime: this.farFutureExpire(),
                usageMetadata: undefined
            };
        this.sessionSlotInfo.set(name, info);
        return info;
    }

    /** Long expiry sentinel so the UI countdown treats slot caches as persistent. */
    private farFutureExpire(): number {
        return Date.now() + 365 * 24 * 3600 * 1000;
    }

    /**
     * Erase the in-memory slot. The on-disk file is not removed (no delete API);
     * next save with the same filename will overwrite it.
     */
    async deleteCache(_name: string): Promise<void> {
        try {
            await fetch(`${this.baseUrl()}/slots/${this.slotId}?action=erase`, {
                method: 'POST'
            });
        } catch (e) {
            console.warn('[LlamaV2] deleteCache erase failed:', e);
        }
        this.sessionSlotInfo.clear();
        this.pendingSaveFilename = null;
        this.pendingSaveHash = null;
        // Forget the saved hash for the current book so the next createCache will
        // queue a fresh save (user-triggered cache clear = "treat disk .bin as stale").
        localStorage.removeItem(`llama_slot_saved_hash_${this.activeBookKey()}`);
        this.pendingSaveHashKey = null;
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
