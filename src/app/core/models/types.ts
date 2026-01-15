import { LLMPart } from '../services/llm-provider';

export type Schema = object;

// New nested response structure (analysis -> response)
export interface EngineResponseNested {
    analysis: string;
    response: {
        story: string;
        summary: string;
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
    usage?: { prompt: number, candidates: number, cached: number };
    isRefOnly?: boolean;
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
    estimatedCost: number;
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
