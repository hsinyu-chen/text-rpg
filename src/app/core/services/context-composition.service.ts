import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { LLMContent, LLMProviderCapabilities } from '@hcs/llm-core';

import { GameStateService } from './game-state.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { AppConfigStore } from './app-config-store';
import { ContextBuilderService, BuildContext } from './context-builder.service';
import { stripSystemMainMarker } from './profile-compat';
import { ChatMessage } from '../models/types';

/**
 * Composition breakdown for the sidebar context bar. Each segment is counted
 * via the active provider's real `countTokens` (no char-estimation), and
 * cached; only the dynamic input/output tail uses an empirical buffer.
 *
 * Recompute triggers (effect-driven, no callsite hooks):
 *   - `systemPromptTokens` — when `dynamicSystemMainInjection` changes
 *   - `injection*Tokens`   — when any dynamic injection / protocol signal changes
 *   - `historyTokens`      — when `messages()` changes (debounced 500ms so a
 *                             streaming chunk burst converges to one count)
 *
 * The buffer (user input + CoT thinking + output) is empirically calibrated
 * from the last model message's observed `contextTokens`; falls back to
 * 5000 (covers 2-3K CoT + user input + a normal output) for cold start
 * and any time the subtraction produces a smaller number.
 */
@Injectable({ providedIn: 'root' })
export class ContextCompositionService {
    private state = inject(GameStateService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private appConfig = inject(AppConfigStore);
    private contextBuilder = inject(ContextBuilderService);

    private static readonly BUFFER_FLOOR = 5000;
    private static readonly HISTORY_DEBOUNCE_MS = 500;

    // Signals — all start at zero; effects fill them in asynchronously after
    // the first relevant change. Never set from a component; updated only by
    // the recompute methods below.
    readonly systemPromptTokens = signal(0);
    readonly historyCompressedTokens = signal(0);
    readonly historyRecentTokens = signal(0);
    readonly historyTokens = computed(() =>
        this.historyCompressedTokens() + this.historyRecentTokens()
    );
    readonly injectionResolverTokens = signal(0);
    readonly injectionNarratorTokens = signal(0);
    readonly injectionSingleTokens = signal(0);

    // Worst case across resolver/narrator in two-call mode — either call
    // hitting the context window cap is what causes a 400, so the bar's
    // injection segment must reflect the larger one.
    readonly effectiveInjectionTokens = computed(() => {
        if (this.appConfig.engineMode() === 'two-call') {
            return Math.max(this.injectionResolverTokens(), this.injectionNarratorTokens());
        }
        return this.injectionSingleTokens();
    });

    // Static (countTokens'd) parts that survive across turns. Buffer is
    // computed from `lastTotal - knownStatic` so the empirical calibration
    // refers back to the same number that the bar already shows.
    private readonly knownStaticTokens = computed(() =>
        this.systemPromptTokens()
        + this.state.estimatedKbTokens()
        + this.historyTokens()
        + this.effectiveInjectionTokens()
    );

    /** Last observed post-turn KV occupancy from the most recent committed model message. */
    private readonly lastObservedTotal = computed<number>(() => {
        const messages = this.state.messages();
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role !== 'model' || m.isRefOnly) continue;
            if (m.contextTokens != null) return m.contextTokens;
            if (m.usage) return (m.usage.prompt || 0) + (m.usage.candidates || 0);
        }
        return 0;
    });

    readonly bufferTokens = computed<number>(() => {
        const observed = this.lastObservedTotal();
        if (observed === 0) return ContextCompositionService.BUFFER_FLOOR;
        const derived = observed - this.knownStaticTokens();
        return Math.max(ContextCompositionService.BUFFER_FLOOR, derived);
    });

    readonly totalTokens = computed<number>(() =>
        this.knownStaticTokens() + this.bufferTokens()
    );

    // History recompute is async and debounced. Track a counter so a stale
    // in-flight count doesn't overwrite a newer one.
    private historyDebounceHandle: ReturnType<typeof setTimeout> | null = null;
    private historyComputeSeq = 0;

    constructor() {
        effect(() => {
            const sysText = stripSystemMainMarker(this.state.systemInstructionCache());
            // Tracking activeProvider() so the count re-runs once a provider
            // registers (otherwise the first read on app boot can hit a null
            // provider and silently set 0).
            this.providerRegistry.activeProvider();
            void this.recomputeSystemTokens(sysText);
        });

        effect(() => {
            const action = this.state.dynamicActionInjection();
            const protocolR = this.state.dynamicProtocolResolverInjection();
            const protocolN = this.state.dynamicProtocolNarratorInjection();
            const protocolS = this.state.dynamicProtocolSingleInjection();
            this.providerRegistry.activeProvider();
            void this.recomputeInjectionTokens({ action, protocolR, protocolN, protocolS });
        });

        effect(() => {
            // Read every input getLLMHistory consumes so the debounce schedules on
            // any structural change. Streaming touches messages() per chunk;
            // the debounce collapses the burst so we tokenize once per stable
            // history.
            this.state.messages();
            this.appConfig.smartContextTurns();
            this.state.contextMode();

            if (this.historyDebounceHandle !== null) {
                clearTimeout(this.historyDebounceHandle);
            }
            this.historyDebounceHandle = setTimeout(() => {
                this.historyDebounceHandle = null;
                void this.recomputeHistoryTokens();
            }, ContextCompositionService.HISTORY_DEBOUNCE_MS);
        });
    }

    private async countText(text: string): Promise<number> {
        if (!text) return 0;
        const provider = this.providerRegistry.activeProvider();
        if (!provider) return 0;
        const config = this.providerRegistry.getActiveConfig();
        const modelId = this.providerRegistry.getActiveModelId() || '';
        try {
            return await provider.countTokens(config, modelId, [{ role: 'user', parts: [{ text }] }]);
        } catch (err) {
            console.warn('[ContextComposition] countTokens(text) failed:', err);
            return 0;
        }
    }

    private async countContents(contents: LLMContent[]): Promise<number> {
        if (contents.length === 0) return 0;
        const provider = this.providerRegistry.activeProvider();
        if (!provider) return 0;
        const config = this.providerRegistry.getActiveConfig();
        const modelId = this.providerRegistry.getActiveModelId() || '';
        try {
            return await provider.countTokens(config, modelId, contents);
        } catch (err) {
            console.warn('[ContextComposition] countTokens(contents) failed:', err);
            return 0;
        }
    }

    private async recomputeSystemTokens(text: string): Promise<void> {
        const count = await this.countText(text);
        this.systemPromptTokens.set(count);
    }

    private async recomputeInjectionTokens(parts: {
        action: string; protocolR: string; protocolN: string; protocolS: string;
    }): Promise<void> {
        // Resolver & single carry the action template at the user-message tail
        // alongside the matching protocol; narrator never sees the action
        // template because its input is the synthetic narrator message.
        const [a, r, n, s] = await Promise.all([
            this.countText(parts.action),
            this.countText(parts.protocolR),
            this.countText(parts.protocolN),
            this.countText(parts.protocolS)
        ]);
        this.injectionResolverTokens.set(r + a);
        this.injectionNarratorTokens.set(n);
        this.injectionSingleTokens.set(s + a);
    }

    private async recomputeHistoryTokens(): Promise<void> {
        const seq = ++this.historyComputeSeq;
        const messages = this.state.messages();
        // Exclude in-progress streaming message (no usage yet, content
        // shifting per chunk). The debounce already absorbs streaming bursts,
        // but a final tokenize on a half-built model message would still
        // give a misleading mid-flight number.
        const stableMessages = messages.filter((m, idx) => {
            if (idx !== messages.length - 1) return true;
            if (m.role !== 'model') return true;
            return !m.isThinking && m.usage != null;
        });

        const ctx = this.buildLightContext(stableMessages);
        const { compressed, recent } = this.contextBuilder.getLLMHistorySegments(ctx);
        const [compressedCount, recentCount] = await Promise.all([
            this.countContents(compressed),
            this.countContents(recent)
        ]);

        // Drop result if a newer recompute has been queued in the meantime.
        if (seq !== this.historyComputeSeq) return;
        this.historyCompressedTokens.set(compressedCount);
        this.historyRecentTokens.set(recentCount);
    }

    /**
     * Minimal BuildContext for `getLLMHistory` — that method only reads
     * messages / contextMode / smartContextTurns (and ignores the rest for
     * non-save context flow). Other fields are filled with safe defaults so
     * we don't have to thread the full snapshot through.
     */
    private buildLightContext(messages: ChatMessage[]): BuildContext {
        const provider = this.providerRegistry.activeProvider();
        const providerCapabilities: LLMProviderCapabilities = provider?.getCapabilities()
            ?? ({ cacheBakesContent: true } as LLMProviderCapabilities);
        return {
            messages,
            contextMode: this.state.contextMode(),
            saveContextMode: this.state.saveContextMode(),
            smartContextTurns: this.appConfig.smartContextTurns(),
            systemInstructionCache: this.state.systemInstructionCache(),
            loadedFiles: this.state.loadedFiles(),
            kbCacheName: this.state.kbCacheName(),
            providerCapabilities,
            dynamicAction: this.state.dynamicActionInjection(),
            dynamicContinue: this.state.dynamicContinueInjection(),
            dynamicFastforward: this.state.dynamicFastforwardInjection(),
            dynamicSystem: this.state.dynamicSystemInjection(),
            dynamicSave: this.state.dynamicSaveInjection(),
            dynamicProtocolResolver: this.state.dynamicProtocolResolverInjection(),
            dynamicProtocolNarrator: this.state.dynamicProtocolNarratorInjection(),
            dynamicProtocolSingle: this.state.dynamicProtocolSingleInjection(),
            dynamicCorrection: this.state.dynamicCorrectionInjection(),
            engineMode: this.appConfig.engineMode()
        } satisfies BuildContext as BuildContext;
    }
}
