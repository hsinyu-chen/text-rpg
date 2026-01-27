import { Injectable, signal, computed, inject } from '@angular/core';
import { ChatMessage } from '../models/types';
import { CostService } from './cost.service';
import { KnowledgeService } from './knowledge.service';

/**
 * Configuration for the game engine.
 */
export interface GameEngineConfig {
    apiKey?: string;
    modelId?: string;
    fontSize?: number;
    fontFamily?: string;
    enableCache?: boolean;
    exchangeRate?: number;
    currency?: string;
    enableConversion?: boolean;
    screensaverType?: 'invaders' | 'code';
    outputLanguage?: string;
    idleOnBlur?: boolean;
    thinkingLevelStory?: string;
    thinkingLevelGeneral?: string;
    smartContextTurns?: number;
}

/**
 * Centralized state service for the game engine.
 * This service holds all signals (reactive state) and computed values.
 * Domain services inject this to read/write state.
 * Components can inject this directly to read state.
 */
@Injectable({
    providedIn: 'root'
})
export class GameStateService {
    private cost = inject(CostService);
    private kb = inject(KnowledgeService);

    // ==================== Configuration ====================
    config = signal<GameEngineConfig | null>(null);
    isConfigured = computed(() => !!this.config()?.apiKey);

    // ==================== Status ====================
    status = signal<'idle' | 'loading' | 'generating' | 'error'>('idle');
    isBusy = computed(() => this.status() === 'loading' || this.status() === 'generating');
    criticalError = signal<string | null>(null);

    // ==================== Chat Messages ====================
    messages = signal<ChatMessage[]>([]);

    // ==================== Files & Knowledge Base ====================
    loadedFiles = signal<Map<string, string>>(new Map());
    fileTokenCounts = signal<Map<string, number>>(new Map());
    estimatedKbTokens = signal<number>(0);
    unsavedFiles = signal<Set<string>>(new Set());

    // Reactive KB Hash
    currentKbHash = computed(() => {
        const files = this.loadedFiles();
        const modelId = this.config()?.modelId || 'gemini-prod';
        const systemInstruction = this.systemInstructionCache();

        const kbText = this.kb.buildKnowledgeBaseText(files);
        return this.kb.calculateKbHash(kbText, modelId, systemInstruction);
    });

    // ==================== Cache ====================
    kbCacheName = signal<string | null>(null);
    kbCacheExpireTime = signal<number | null>(null);

    // Delegate to CostService for cache countdown
    cacheCountdown = this.cost.cacheCountdown;
    storageUsageAccumulated = this.cost.storageUsageAccumulated;

    // ==================== Token Usage & Cost ====================
    tokenUsage = signal<{ freshInput: number; cached: number; output: number; total: number }>({
        freshInput: 0,
        cached: 0,
        output: 0,
        total: 0
    });
    estimatedCost = signal<number>(0);
    lastTurnUsage = signal<{ freshInput: number; cached: number; output: number } | null>(null);
    lastTurnCost = signal<number>(0);
    historyStorageUsageAccumulated = signal<number>(0);
    sunkUsageHistory = signal<{ prompt: number, cached: number, candidates: number }[]>([]);

    constructor() {
        // Restore history usage from NEW localstorage key
        const savedHistory = localStorage.getItem('history_storage_usage_acc');
        if (savedHistory) {
            this.historyStorageUsageAccumulated.set(parseFloat(savedHistory));
        }
    }

    // ==================== Dynamic Injection ====================
    enableDynamicInjection = signal<boolean>(true);
    dynamicActionInjection = signal<string>('');
    dynamicContinueInjection = signal<string>('');
    dynamicFastforwardInjection = signal<string>('');
    dynamicSystemInjection = signal<string>('');
    dynamicSaveInjection = signal<string>('');
    dynamicSystemMainInjection = signal<string>('');
    postProcessScript = signal<string>('');

    // Flag to prevent effects from saving until after initial load
    injectionSettingsLoaded = signal(false);

    // ==================== Prompt Updates ====================
    // Track status of prompt file updates: type -> { hasUpdate: boolean, serverContent: string }
    promptUpdateStatus = signal<Map<string, { hasUpdate: boolean, serverContent: string }>>(new Map());
    hasAnyPromptUpdate = computed(() => {
        for (const status of this.promptUpdateStatus().values()) {
            if (status.hasUpdate) return true;
        }
        return false;
    });

    // ==================== Context Mode ====================
    contextMode = signal<'smart' | 'full' | 'summarized'>('smart');
    saveContextMode = signal<'smart' | 'full' | 'summarized'>('full');

    // ==================== Save Prompt ====================
    private static readonly SAVE_PROMPT_THRESHOLD = 10;

    // Count turns (user messages) since ACT START
    turnsSinceActStart = computed(() => {
        const msgs = this.messages();
        // Use robust billing logic: Count all valid model turns in the current session
        return msgs.filter(m => m.role === 'model' && !m.isRefOnly).length;
    });

    // Prompt save when: cached > new & new > 15K & turn > 10
    shouldPromptSave = computed(() => {
        const lastTurn = this.lastTurnUsage();
        const turnCount = this.turnsSinceActStart();

        if (!lastTurn) return false;

        // Condition: cached > new token (freshInput) AND new token > 15K AND turn > 10
        return lastTurn.cached > lastTurn.freshInput &&
            lastTurn.freshInput > 15000 &&
            turnCount > GameStateService.SAVE_PROMPT_THRESHOLD;
    });

    // ==================== Internal State (non-signal) ====================
    // These are mutable internal state used by services
    kbCacheTokens = signal<number>(0);
    systemInstructionCache = computed(() => this.dynamicSystemMainInjection());
    isContextInjected = false;
    injectionContentHash = '';
}
