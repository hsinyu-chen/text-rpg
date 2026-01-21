/**
 * LLM Provider Abstraction Layer
 *
 * Provider-agnostic types and interfaces for AI/LLM services.
 * Enables switching between different AI backends (Gemini, llama.cpp, etc.)
 * without modifying GameEngineService.
 */

// ============================================================================
// Default Constants
// ============================================================================

/** Default LLM provider ID */
export const DEFAULT_PROVIDER_ID = 'gemini';

// ============================================================================
// Core Types (Provider-Agnostic)
// ============================================================================

/**
 * Provider-agnostic content structure for chat messages.
 * Maps to Gemini's Content, OpenAI's messages, etc.
 */
export interface LLMContent {
    role: 'user' | 'model' | 'system';
    parts: LLMPart[];
}

/**
 * Provider-agnostic part structure for message content.
 */
export interface LLMPart {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: object;
    functionResponse?: object;
    // For file/image references (Gemini-specific, but kept for compatibility)
    fileData?: {
        fileUri: string;
        mimeType: string;
    };
}

/**
 * Generation configuration options.
 */
export interface LLMGenerateConfig {
    responseSchema?: object;
    responseMimeType?: string;
    cachedContentName?: string;
    tools?: object[];
    toolConfig?: object;
    intent?: string;
    signal?: AbortSignal;
}

/**
 * Token usage metadata from a generation response.
 */
export interface LLMUsageMetadata {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
}

/**
 * A single chunk from a streaming response.
 */
export interface LLMStreamChunk {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    usageMetadata?: LLMUsageMetadata;
    functionCall?: object;
    finishReason?: string;
}

/**
 * File upload result.
 */
export interface LLMFileInfo {
    uri: string;
    name: string;
}

/**
 * Cache information.
 */
export interface LLMCacheInfo {
    name: string;
    displayName?: string;
    model: string;
    createTime?: number;  // Unix timestamp
    expireTime?: number;  // Unix timestamp
    usageMetadata?: { totalTokenCount: number };
}

// ============================================================================
// Model & Pricing Types
// ============================================================================

/**
 * Pricing rates for a model (per 1M tokens).
 */
export interface LLMPricingRates {
    input: number;        // Price per 1M input tokens
    output: number;       // Price per 1M output tokens
    cached?: number;      // Price per 1M cached tokens (optional)
    cacheStorage?: number; // Price per 1M tokens per hour storage (optional)
}

/**
 * Model definition with pricing.
 */
export interface LLMModelDefinition {
    id: string;
    name: string;
    /** Returns pricing rates, optionally based on prompt size */
    getRates: (promptTokens?: number) => LLMPricingRates;
    /** Whether this model supports thinking/reasoning config */
    supportsThinking?: boolean;
}

// ============================================================================
// Provider Capabilities
// ============================================================================

/**
 * Feature flags for capability detection.
 * Used by GameEngineService to determine which features are available.
 */
export interface LLMProviderCapabilities {
    /** Provider supports file upload API */
    supportsFileUpload: boolean;
    /** Provider supports context caching (Gemini-specific) */
    supportsContextCaching: boolean;
    /** Provider supports thinking/reasoning mode */
    supportsThinking: boolean;
    /** Provider supports structured JSON output */
    supportsStructuredOutput: boolean;
    /** Provider runs locally (no API costs) */
    isLocalProvider: boolean;
}

// ============================================================================
// Main Provider Interface
// ============================================================================

/**
 * The main interface that all LLM providers must implement.
 *
 * Required methods:
 * - initialize(): Set up the provider with API keys, endpoints, etc.
 * - generateContentStream(): Stream a response from the model
 * - countTokens(): Count tokens for a given content
 * - getCapabilities(): Return feature flags
 *
 * Optional methods (implement only if supported):
 * - uploadFile(), isFileAvailable(), deleteAllFiles(): File operations
 * - createCache(), getCache(), updateCacheTTL(), deleteCache(), deleteAllCaches(): Caching
 */
export interface LLMProvider {
    /** Unique identifier for this provider (e.g., 'gemini', 'llama.cpp') */
    readonly providerName: string;

    // -------------------------------------------------------------------------
    // Required Methods
    // -------------------------------------------------------------------------

    /**
     * Initialize the provider with configuration.
     * @param config Provider-specific configuration (API key, endpoint, model ID, etc.)
     */
    init(config: LLMProviderConfig): void;

    /**
     * Generate content with streaming response.
     * @param contents The chat history/context
     * @param systemInstruction System-level prompt
     * @param config Generation configuration
     * @returns Async iterator yielding response chunks
     */
    generateContentStream(
        contents: LLMContent[],
        systemInstruction: string,
        config: LLMGenerateConfig
    ): AsyncIterable<LLMStreamChunk>;

    /**
     * Count tokens for given content.
     * @param modelId The model to use for tokenization
     * @param contents The content to tokenize
     * @returns Token count
     */
    countTokens(modelId: string, contents: LLMContent[]): Promise<number>;

    /**
     * Get capability flags for this provider.
     */
    getCapabilities(): LLMProviderCapabilities;

    /**
     * Get available models for this provider with pricing info.
     */
    getAvailableModels(): LLMModelDefinition[];

    /**
     * Get the default model ID for this provider.
     */
    getDefaultModelId(): string;

    /**
     * Get a preview-friendly version of the contents.
     * Useful for UI displays where some sensitive or large data should be hidden.
     */
    getPreview?(contents: LLMContent[]): LLMContent[];

    // -------------------------------------------------------------------------
    // Optional Methods - File Operations
    // -------------------------------------------------------------------------

    /**
     * Upload a file to the provider's storage.
     */
    uploadFile?(blob: Blob, mimeType: string): Promise<LLMFileInfo>;

    /**
     * Check if a file is still available on the server.
     */
    isFileAvailable?(uri: string): Promise<boolean>;

    /**
     * Delete all uploaded files (optionally excluding one).
     */
    deleteAllFiles?(excludeUri?: string): Promise<void>;

    // -------------------------------------------------------------------------
    // Optional Methods - Context Caching
    // -------------------------------------------------------------------------

    /**
     * Create a context cache.
     */
    createCache?(
        modelId: string,
        systemInstruction: string,
        contents: LLMContent[],
        ttlSeconds: number
    ): Promise<LLMCacheInfo | null>;

    /**
     * Get cache status by name.
     */
    getCache?(name: string): Promise<LLMCacheInfo | null>;

    /**
     * Update cache TTL.
     */
    updateCacheTTL?(name: string, ttlSeconds: number): Promise<LLMCacheInfo | null>;

    /**
     * Delete a specific cache.
     */
    deleteCache?(name: string): Promise<void>;

    /**
     * Delete all caches.
     */
    deleteAllCaches?(): Promise<number>;
}

// ============================================================================
// Provider Configuration
// ============================================================================

/**
 * Base configuration that all providers accept.
 * Providers may extend this with additional fields.
 */
export interface LLMProviderConfig {
    /** API key (for cloud providers) */
    apiKey?: string;
    /** Model ID to use */
    modelId?: string;
    /** Base URL for the API endpoint (for self-hosted providers) */
    baseUrl?: string;
    /** Thinking level for story context */
    thinkingLevelStory?: string;
    /** Thinking level for general context */
    thinkingLevelGeneral?: string;
}
