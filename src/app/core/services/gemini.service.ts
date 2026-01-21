import { Injectable } from '@angular/core';
import { CachedContent, Content, Part, CreateCachedContentParameters, CreateCachedContentConfig, GoogleGenAI, ThinkingLevel, GenerateContentParameters, GenerateContentConfig, Tool, HarmCategory, HarmBlockThreshold } from '@google/genai';

import { Schema } from '../models/types';
import {
    LLMProvider,
    LLMProviderCapabilities,
    LLMProviderConfig,
    LLMContent,
    LLMPart,
    LLMGenerateConfig,
    LLMStreamChunk,
    LLMModelDefinition,
    LLMCacheInfo
} from './llm-provider';

/** Default Gemini model ID */
export const DEFAULT_GEMINI_MODEL_ID = 'gemini-3-flash-preview';

@Injectable({
    providedIn: 'root'
})
export class GeminiService implements LLMProvider {
    readonly providerName = 'gemini';

    private client: GoogleGenAI = null!;
    private lastModelId: string = DEFAULT_GEMINI_MODEL_ID;

    private readonly defaultTools: Tool[] = [];

    // =========================================================================
    // LLMProvider Interface - Converters
    // =========================================================================

    /**
     * Convert provider-agnostic LLMContent to Gemini Content format.
     */
    private toGeminiContent(content: LLMContent): Content {
        return {
            role: content.role === 'system' ? 'user' : content.role,
            parts: content.parts.map(p => this.toGeminiPart(p))
        };
    }

    /**
     * Convert provider-agnostic LLMPart to Gemini Part format.
     */
    private toGeminiPart(part: LLMPart): Part {
        const result: Part = {};
        if (part.text !== undefined) result.text = part.text;
        if (part.functionCall) result.functionCall = part.functionCall as Part['functionCall'];
        if (part.functionResponse) result.functionResponse = part.functionResponse as Part['functionResponse'];
        if (part.fileData) result.fileData = part.fileData;
        return result;
    }

    // =========================================================================
    // LLMProvider Interface - Required Methods
    // =========================================================================

    /**
     * Get capability flags for Gemini provider.
     */
    getCapabilities(): LLMProviderCapabilities {
        return {
            supportsFileUpload: true,
            supportsContextCaching: true,
            supportsThinking: true,
            supportsStructuredOutput: true,
            isLocalProvider: false
        };
    }

    /**
     * Get available Gemini models with pricing.
     */
    getAvailableModels(): LLMModelDefinition[] {
        return [
            {
                id: 'gemini-3-pro-preview',
                name: 'Gemini 3 Pro Preview',
                getRates: (prompt = 0) => {
                    const isLong = prompt > 200000;
                    return {
                        input: isLong ? 4.00 : 2.00,
                        output: isLong ? 18.00 : 12.00,
                        cached: isLong ? 0.40 : 0.20,
                        cacheStorage: 4.50
                    };
                }
            },
            {
                id: 'gemini-3-flash-preview',
                name: 'Gemini 3 Flash Preview',
                getRates: () => {
                    return {
                        input: 0.50,
                        output: 3.00,
                        cached: 0.05,
                        cacheStorage: 1.00
                    };
                }
            }
        ];
    }

    /**
     * Get default model ID for Gemini.
     */
    getDefaultModelId(): string {
        return DEFAULT_GEMINI_MODEL_ID;
    }

    /**
     * Initialize using LLMProviderConfig (LLMProvider interface method).
     */
    init(config: LLMProviderConfig): void {
        if (!config.apiKey) throw new Error('Gemini requires an API key.');
        this.initialize(
            config.apiKey,
            config.modelId || DEFAULT_GEMINI_MODEL_ID
        );
    }

    /**
     * Implements LLMProvider.generateContentStream using provider-agnostic types.
     */
    async *generateContentStream(
        contents: LLMContent[],
        systemInstruction: string,
        config: LLMGenerateConfig
    ): AsyncGenerator<LLMStreamChunk> {
        // Convert to Gemini format
        const geminiContents = contents.map(c => this.toGeminiContent(c));

        // Use existing method
        const stream = await this.sendMessageStream(
            geminiContents,
            systemInstruction,
            config.cachedContentName,
            config.responseSchema as Schema,
            config.responseMimeType,
            config.toolConfig
        );

        // Yield converted chunks
        for await (const chunk of stream) {
            // Check for abortion
            if (config.signal?.aborted) {
                return; // Stop yielding
            }

            const candidate = chunk.candidates?.[0];
            const finishReason = candidate?.finishReason;

            if (candidate?.content?.parts) {
                for (const part of candidate.content.parts) {
                    const extPart = part as Part & { thought?: boolean; thoughtSignature?: string };
                    yield {
                        text: extPart.text,
                        thought: extPart.thought,
                        thoughtSignature: extPart.thoughtSignature,
                        functionCall: extPart.functionCall as object | undefined,
                        finishReason,
                        usageMetadata: chunk.usageMetadata ? {
                            promptTokens: chunk.usageMetadata.promptTokenCount || 0,
                            completionTokens: chunk.usageMetadata.candidatesTokenCount || 0,
                            cachedTokens: chunk.usageMetadata.cachedContentTokenCount
                        } : undefined
                    };
                }
            } else if (finishReason) {
                // Yield reason even if no parts (e.g. blocked or max tokens)
                yield {
                    finishReason,
                    usageMetadata: chunk.usageMetadata ? {
                        promptTokens: chunk.usageMetadata.promptTokenCount || 0,
                        completionTokens: chunk.usageMetadata.candidatesTokenCount || 0,
                        cachedTokens: chunk.usageMetadata.cachedContentTokenCount
                    } : undefined
                };
            }
        }
    }

    /**
     * Get a preview-friendly version of the contents for Gemini.
     * Removes thoughtSignature as requested.
     */
    getPreview(contents: LLMContent[]): LLMContent[] {
        return contents.map(content => ({
            ...content,
            parts: content.parts.map(part => {
                const newPart = { ...part };
                delete newPart.thoughtSignature;
                return newPart;
            })
        }));
    }

    // =========================================================================
    // Original Methods (Backward Compatibility)
    // =========================================================================

    /**
     * Initializes the Gemini client with the provided API key and model configuration.
     * @param apiKey The Gemini API Key.
     * @param modelId The Gemini Model ID.
     */
    initialize(apiKey: string, modelId: string) {
        this.client = new GoogleGenAI({ apiKey });
        this.lastModelId = modelId;
    }

    /**
     * Uploads a file (blob) to the Gemini File API.
     * @param blob The file content as a Blob.
     * @param mimeType The file's MIME type.
     * @returns Object containing the uploaded file's URI and name.
     */
    async uploadFile(blob: Blob, mimeType: string): Promise<{ uri: string, name: string }> {
        if (!this.client) throw new Error('Gemini client not initialized.');

        const response = await this.client.files.upload({
            file: blob,
            config: { mimeType }
        });

        return { uri: response.uri!, name: response.name! };
    }

    /**
     * Checks if a specific file URI is active and available on the server.
     * @param uri The file URI or name.
     * @returns True if the file is active, false otherwise.
     */
    async isFileAvailable(uri: string): Promise<boolean> {
        if (!this.client) return false;
        try {
            const response = await this.client.files.list();
            for await (const f of response) {
                if ((f.uri === uri || (f.name && uri.endsWith(f.name))) && f.state === 'ACTIVE') {
                    return true;
                }
            }
        } catch (e) {
            console.warn('Error checking file availability:', e);
        }
        return false;
    }

    /**
     * Lists and deletes all uploaded files from the Gemini server.
     * @param excludeUri Optional URI to exclude from deletion.
     */
    async listAndDeleteAllFiles(excludeUri?: string) {
        if (!this.client) return;
        try {
            const response = await this.client.files.list();

            let deletedCount = 0;
            for await (const f of response) {
                // Check exclusion by URI match or name
                if (excludeUri && (f.uri === excludeUri || (f.name && excludeUri.endsWith(f.name)))) {
                    continue;
                }
                if (f.name) {
                    try {
                        await this.client.files.delete({ name: f.name });
                        deletedCount++;
                    } catch (delErr) {
                        console.warn(`Failed to delete file ${f.name}:`, delErr);
                    }
                }
            }

            if (deletedCount > 0) {
                console.log(`Deleted ${deletedCount} old files from Google storage.`);
            }
        } catch (e) {
            console.error('Error cleaning up files:', e);
        }
    }
    /**
     * Sends a stream of contents and system instructions to the Gemini model for generation.
     * @param contents Array of Content objects representing chat history.
     * @param systemInstruction The system-level prompt.
     * @param cachedContentName Optional name of the context cache to use.
     * @param responseSchema Optional JSON schema for structured output.
     * @param responseMimeType Optional MIME type for the response (e.g., 'application/json').
     * @param toolConfig Optional configuration for tools.
     * @returns A streaming response object.
     */
    async sendMessageStream(contents: Content[], systemInstruction: string, cachedContentName?: string, responseSchema?: Schema, responseMimeType?: string, toolConfig?: object) {
        if (!this.client) throw new Error('Gemini client not initialized. Call initialize() first.');

        // Build config object dynamicly to allow API defaults
        const generationConfig: GenerateContentConfig = {
            thinkingConfig: {
                includeThoughts: true,
                thinkingLevel: ThinkingLevel.HIGH
            },
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE }
            ]
        };


        // If using cache, DO NOT send systemInstruction again as it is baked into the cache
        if (systemInstruction && !cachedContentName) {
            generationConfig.systemInstruction = {
                parts: [{ text: systemInstruction }]
            };
        }

        if (cachedContentName) {
            generationConfig.cachedContent = cachedContentName;
        } else {
            // Only include tools if NOT using cache (tools must be baked into cache otherwise)
            generationConfig.tools = this.defaultTools;
        }

        if (responseMimeType) generationConfig.responseMimeType = responseMimeType;
        if (responseSchema) generationConfig.responseSchema = responseSchema;
        // API Limitation: toolConfig cannot be used with CachedContent.
        if (toolConfig && !cachedContentName) generationConfig.toolConfig = toolConfig;

        const request: GenerateContentParameters = {
            model: this.lastModelId,
            contents: contents,
            config: generationConfig
        };

        const response = await this.client.models.generateContentStream(request);

        return response;
    }


    /**
     * Counts the number of tokens in a set of contents for a specific model.
     * @param model The model ID.
     * @param contents Array of Content objects.
     * @returns The total token count.
     */
    async countTokens(model: string, contents: Content[]): Promise<number> {
        if (!this.client) return 0;
        try {
            const response = await this.client.models.countTokens({
                model: model,
                contents: contents
            });
            return response.totalTokens || 0;
        } catch (e) {
            console.warn('Failed to count tokens:', e);
            return 0;
        }
    }

    /**
     * Creates a context cache on the Gemini server.
     * Gemini-specific method for backward compatibility.
     * @param model The model ID.
     * @param systemInstruction The system-level prompt to bake into the cache.
     * @param contents The content history to bake into the cache.
     * @param ttlSeconds The time-to-live for the cache in seconds.
     * @returns The created CachedContent object or null on failure.
     */
    async createGeminiCache(model: string, systemInstruction: string, contents: Content[], ttlSeconds = 1800): Promise<CachedContent | null> {
        if (!this.client) return null;
        try {
            const config: CreateCachedContentConfig = {
                contents: contents, // Content[] matches ContentListUnion
                systemInstruction: {
                    parts: [{ text: systemInstruction }]
                },
                tools: this.defaultTools,
                ttl: `${ttlSeconds}s`
            };

            const params: CreateCachedContentParameters = {
                model,
                config
            };

            const cache = await this.client.caches.create(params);
            return cache;
        } catch (e) {
            console.warn('Cache creation failed:', e);
            return null;
        }
    }

    /**
     * Updates the TTL of an existing context cache.
     * Gemini-specific method for backward compatibility.
     * @param name The name of the cache resource.
     * @param ttlSeconds The new time-to-live in seconds.
     * @returns The updated CachedContent object or null on failure.
     */
    async updateGeminiCache(name: string, ttlSeconds: number): Promise<CachedContent | null> {
        if (!this.client) return null;
        try {
            const cache = await this.client.caches.update({
                name,
                config: {
                    ttl: `${ttlSeconds}s`
                }
            });
            console.log('Cache TTL updated:', name);
            return cache;
        } catch (e) {
            console.warn('Failed to update cache:', e);
            return null;
        }
    }

    /**
     * Deletes a specific context cache from the server.
     * @param name The name of the cache resource.
     */
    async deleteCache(name: string): Promise<void> {
        if (!this.client) return;
        try {
            await this.client.caches.delete({ name });
            console.log('Cache deleted:', name);
        } catch (e) {
            console.warn('Failed to delete cache:', e);
        }
    }

    /**
     * Retrieves the status and metadata of a specific context cache.
     * Gemini-specific method for backward compatibility.
     * @param name The name of the cache resource.
     * @returns The CachedContent object or null if not found.
     */
    async getGeminiCache(name: string): Promise<CachedContent | null> {
        if (!this.client) return null;
        try {
            const cache = await this.client.caches.get({ name });
            return cache;
        } catch (e) {
            console.warn('Failed to get cache:', name, e);
            return null;
        }
    }

    /**
     * Lists and deletes all context caches belongs to the API key on the server.
     * @returns The total number of caches deleted.
     */
    async listAndDeleteAllCaches(): Promise<number> {
        if (!this.client) return 0;
        let count = 0;
        try {
            const list = await this.client.caches.list();
            for await (const cache of list) {
                if (cache.name) {
                    try {
                        await this.client.caches.delete({ name: cache.name });
                        console.log('Deleted cache:', cache.name);
                        count++;
                    } catch (e) {
                        console.warn('Failed to delete cache:', cache.name, e);
                    }
                }
            }
            console.log(`Cleared ${count} caches.`);
        } catch (e) {
            console.warn('Error listing/deleting caches:', e);
        }
        return count;
    }

    // =========================================================================
    // LLMProvider Interface - Cache Operations (Optional)
    // =========================================================================

    /**
     * LLMProvider interface: Create a context cache.
     */
    async createCache(
        modelId: string,
        systemInstruction: string,
        contents: LLMContent[],
        ttlSeconds: number
    ): Promise<LLMCacheInfo | null> {
        const geminiContents = contents.map(c => this.toGeminiContent(c));
        const result = await this.createGeminiCache(modelId, systemInstruction, geminiContents, ttlSeconds);
        if (!result) return null;
        return {
            name: result.name || '',
            displayName: result.displayName || undefined,
            model: result.model || '',
            createTime: result.createTime ? new Date(result.createTime).getTime() : undefined,
            expireTime: result.expireTime ? new Date(result.expireTime).getTime() : undefined,
            usageMetadata: result.usageMetadata ? { totalTokenCount: result.usageMetadata.totalTokenCount || 0 } : undefined
        };
    }

    /**
     * LLMProvider interface: Get cache status by name.
     */
    async getCache(name: string): Promise<LLMCacheInfo | null> {
        const result = await this.getGeminiCache(name);
        if (!result) return null;
        return {
            name: result.name || '',
            displayName: result.displayName || undefined,
            model: result.model || '',
            createTime: result.createTime ? new Date(result.createTime).getTime() : undefined,
            expireTime: result.expireTime ? new Date(result.expireTime).getTime() : undefined,
            usageMetadata: result.usageMetadata ? { totalTokenCount: result.usageMetadata.totalTokenCount || 0 } : undefined
        };
    }

    /**
     * LLMProvider interface: Update cache TTL.
     */
    async updateCacheTTL(name: string, ttlSeconds: number): Promise<LLMCacheInfo | null> {
        const result = await this.updateGeminiCache(name, ttlSeconds);
        if (!result) return null;
        return {
            name: result.name || '',
            displayName: result.displayName || undefined,
            model: result.model || '',
            createTime: result.createTime ? new Date(result.createTime).getTime() : undefined,
            expireTime: result.expireTime ? new Date(result.expireTime).getTime() : undefined,
            usageMetadata: result.usageMetadata ? { totalTokenCount: result.usageMetadata.totalTokenCount || 0 } : undefined
        };
    }

    /**
     * LLMProvider interface: Delete all caches.
     */
    async deleteAllCaches(): Promise<number> {
        return this.listAndDeleteAllCaches();
    }

    // =========================================================================
    // LLMProvider Interface - File Operations (Optional)
    // =========================================================================

    /**
     * LLMProvider interface: Delete all files.
     */
    async deleteAllFiles(excludeUri?: string): Promise<void> {
        await this.listAndDeleteAllFiles(excludeUri);
    }
}

