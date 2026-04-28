import { LLMPart, LLMUsageMetadata } from '@hcs/llm-core';

export type Schema = object;

// New nested response structure (analysis -> response)
export interface EngineResponseNested {
    analysis: string;
    response: {
        story: string;
        summary: string;
        character_log?: string[];
        inventory_log?: string[];
        quest_log?: string[];
        world_log?: string[];
        isCorrection?: boolean;
    };
}

// Old flat response structure (for backward compatibility with old saved data)
export interface EngineResponseFlat {
    analysis: string;
    story: string;
    summary: string;
    correction?: string; // Deprecated: old format used string, now we use isCorrection boolean
}

// Union type supporting both old and new formats
export type EngineResponse = EngineResponseNested | EngineResponseFlat;



export type ExtendedPart = LLMPart;

export interface ThoughtPart {
    text?: string;
    thought?: boolean;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'model';
    content: string;
    thought?: string;
    isThinking?: boolean;
    parts?: ExtendedPart[];
    usage?: LLMUsageMetadata;
    progress?: number;
    isRefOnly?: boolean;
    character_log?: string[];
    inventory_log?: string[];
    quest_log?: string[];
    world_log?: string[];
    isHidden?: boolean;
    analysis?: string;
    summary?: string;
    intent?: string;
    isManualRefOnly?: boolean;
    isCorrection?: boolean;
}

export interface TauriWindow extends Window {
    __TAURI_INTERNALS__?: object;
}

export interface FileSystemWindow extends Window {
    showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>;
}

export interface SessionSave {
    id: string;
    name: string;
    timestamp: number;
    messages: ChatMessage[];
    tokenUsage: { freshInput: number, cached: number, output: number, total: number };
    historyStorageUsage?: number; // Token-Seconds (optional for backward compatibility)
    sunkUsageHistory: { prompt: number, cached: number, candidates: number }[];
    storyPreview: string; // First ~200 chars of last model message for display
    kbHash?: string;
}

export type StorageValue = object | string | number | boolean | null;

export interface Scenario {
    id: string;
    name: string;
    lang: string;
    description?: string;
    baseDir: string;
    files: Record<string, string>;
}

export interface Collection {
    id: string; // UUID, or 'root' for the default system collection
    name: string;
    createdAt: number;
    updatedAt: number;
}

export const ROOT_COLLECTION_ID = 'root';

export interface Book {
    id: string; // UUID
    name: string; // User-friendly name
    collectionId: string; // FK to Collection.id; 'root' for unsorted/legacy
    createdAt: number;
    lastActiveAt: number;
    preview: string; // Short preview text

    // Serialized State
    messages: ChatMessage[];
    files: { name: string, content: string, tokens?: number }[];

    // Stats & Metadata
    stats: {
        tokenUsage: { freshInput: number, cached: number, output: number, total: number };
        estimatedCost: number;
        historyStorageUsage: number;
        sunkUsageHistory: { prompt: number, cached: number, candidates: number }[];

        // Cache Metadata
        kbCacheName: string | null;
        kbCacheExpireTime: number | null; // Timestamp
        kbCacheTokens: number;
        estimatedKbTokens: number; // Added: Total KB tokens for UI display
        kbCacheHash: string | null;
        kbStorageUsageAcc: number; // Active accumulated storage usage (Token-Seconds)
    };
}
// ─── Create World: Presets & Identity options ───────────────────────────────
export interface IdentityOption {
    value: string;
    desc: string; // shown as hint; also default for background
    specialRequests: string;
    alignment?: string;
    interests?: string;
    npcHints?: string;
    appearance?: string;
}

export interface WorldPreset {
    id: string;
    label: string;
    genre: string;
    tone: string;
    setting: string;
    identities: IdentityOption[];
}

