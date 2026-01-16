import { Injectable, signal, computed, inject } from '@angular/core';
import { ChatMessage } from '../models/types';
import { CostService } from './cost.service';

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

    // ==================== Configuration ====================
    config = signal<GameEngineConfig | null>(null);
    isConfigured = computed(() => !!this.config()?.apiKey);

    // ==================== Status ====================
    status = signal<'idle' | 'loading' | 'generating' | 'error'>('idle');
    isBusy = computed(() => this.status() === 'loading' || this.status() === 'generating');

    // ==================== Chat Messages ====================
    messages = signal<ChatMessage[]>([]);

    // ==================== Files & Knowledge Base ====================
    loadedFiles = signal<Map<string, string>>(new Map());
    kbFileUri = signal<string | null>(null);
    fileTokenCounts = signal<Map<string, number>>(new Map());
    estimatedKbTokens = signal<number>(0);
    currentKbHash = signal<string>('');

    // ==================== Cache ====================
    kbCacheName = signal<string | null>(null);
    kbCacheExpireTime = signal<number | null>(null);

    // Delegate to CostService for cache countdown
    cacheCountdown = this.cost.cacheCountdown;
    storageCostAccumulated = this.cost.storageCostAccumulated;

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
    historyStorageCostAccumulated = signal<number>(0);
    sunkUsageHistory = signal<{ prompt: number, cached: number, candidates: number }[]>([]);

    // ==================== Dynamic Injection ====================
    enableDynamicInjection = signal<boolean>(true);
    dynamicActionInjection = signal<string>('');
    dynamicContinueInjection = signal<string>('');
    dynamicFastforwardInjection = signal<string>('');
    dynamicSystemInjection = signal<string>('');
    dynamicSaveInjection = signal<string>('');
    postProcessScript = signal<string>('');

    // Flag to prevent effects from saving until after initial load
    injectionSettingsLoaded = signal(false);

    // ==================== Context Mode ====================
    contextMode = signal<'smart' | 'full'>('smart');

    // ==================== Internal State (non-signal) ====================
    // These are mutable internal state used by services
    kbCacheTokens = 0;
    systemInstructionCache = '';
    isContextInjected = false;
    injectionContentHash = '';
}
