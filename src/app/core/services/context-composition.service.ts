import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { LLMContent, LLMProviderCapabilities } from '@hcs/llm-core';

import { GameStateService } from './game-state.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMConfigService } from './llm-config.service';
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
 *   - `systemPromptTokens` — when `systemInstructionCache` (which derives
 *                             from `dynamicSystemMainInjection`) changes,
 *                             or the active profile / provider changes
 *   - `injection*Tokens`   — when any dynamic injection / protocol signal
 *                             changes, or the active profile / provider
 *                             changes (different model id ⇒ different
 *                             tokenizer ⇒ same text, different count)
 *   - `historyTokens`      — when `messages()` changes (debounced 500ms so
 *                             a streaming chunk burst converges to one
 *                             count), or the active profile / provider
 *                             changes
 *
 * The buffer (next user input + CoT thinking + model output) is empirically
 * calibrated from the last model message's `usage.candidates` — that field
 * is the actual output tokens emitted in the previous turn (Gemini /
 * Claude / OpenAI all roll thinking tokens into candidates), so it
 * captures both the "thinking budget" the model used and the response
 * length. A 5,000-token floor handles cold start (no last turn) and
 * cached-response edge cases where last turn was abnormally cheap.
 *
 * Why `candidates + 256` and not `lastContextTokens − knownStatic`: that
 * subtraction self-cancels because `knownStatic` updates reactively while
 * `lastContextTokens` is a frozen historical number. Adding a message
 * grows `knownStatic` and the buffer derived from subtraction shrinks by
 * the same amount, leaving total unchanged. Using stored `candidates`
 * directly avoids the cancellation entirely.
 */
@Injectable({ providedIn: 'root' })
export class ContextCompositionService {
    private state = inject(GameStateService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private configService = inject(LLMConfigService);
    private appConfig = inject(AppConfigStore);
    private contextBuilder = inject(ContextBuilderService);

    private static readonly BUFFER_FLOOR = 5000;
    private static readonly USER_INPUT_CUSHION = 256;
    private static readonly HISTORY_DEBOUNCE_MS = 500;

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

    /**
     * Empirical buffer = last model message's output tokens (incl. CoT
     * thinking) + a small fixed cushion for the next user input. Floor
     * BUFFER_FLOOR for cold start / cached-response edge cases.
     *
     * In two-call mode `usage.candidates` is the SUM of resolver + narrator
     * outputs; that's a slight over-estimate vs the actual per-call binding
     * constraint, which is the right direction for "will I hit 400".
     */
    readonly bufferTokens = computed<number>(() => {
        const messages = this.state.messages();
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role !== 'model' || m.isRefOnly) continue;
            const candidates = m.usage?.candidates;
            if (candidates && candidates > 0) {
                return Math.max(
                    ContextCompositionService.BUFFER_FLOOR,
                    candidates + ContextCompositionService.USER_INPUT_CUSHION
                );
            }
        }
        return ContextCompositionService.BUFFER_FLOOR;
    });

    readonly totalTokens = computed<number>(() =>
        this.systemPromptTokens()
        + this.state.estimatedKbTokens()
        + this.historyTokens()
        + this.effectiveInjectionTokens()
        + this.bufferTokens()
    );

    // Each async recompute is gated by a sequence number so that an older
    // in-flight `countTokens` can't overwrite a newer one. This bites on
    // rapid profile / engineMode toggles where the user-visible signal flips
    // twice within one round-trip — without the guard, the older reply
    // resolves last and pins the bar to a stale value until the next change.
    private historyDebounceHandle: ReturnType<typeof setTimeout> | null = null;
    private historyComputeSeq = 0;
    private systemComputeSeq = 0;
    private injectionComputeSeq = 0;

    constructor() {
        effect(() => {
            const sysText = stripSystemMainMarker(this.state.systemInstructionCache());
            // activeProfile() catches both provider swaps AND intra-provider
            // model swaps (different modelId ⇒ different tokenizer ⇒ same
            // text counts to a different number of tokens).
            this.configService.activeProfile();
            this.providerRegistry.activeProvider();
            void this.recomputeSystemTokens(sysText);
        });

        effect(() => {
            // All signal reads are synchronous so Angular's effect tracking
            // sees them. Anything read only inside the async tail (countTokens
            // resolution) wouldn't establish a dep.
            const action = this.state.dynamicActionInjection();
            const protocolR = this.state.dynamicProtocolResolverInjection();
            const protocolN = this.state.dynamicProtocolNarratorInjection();
            const protocolS = this.state.dynamicProtocolSingleInjection();
            // Status + messages are tracked because the protocol templates
            // carry a `{{HISTORICAL_CORRECTION_RULE}}` slot whose substitution
            // depends on whether history holds an active correction. The
            // game-side rendering happens at call time via ContextBuilder;
            // we mirror just that one substitution here so the count reflects
            // what would actually be sent on the next turn (a fresh
            // correction-declaration adds ~hundreds of tokens to the rule
            // text from the locale).
            const messages = this.state.messages();
            const lang = this.appConfig.outputLanguage();
            const status = this.state.status();
            this.configService.activeProfile();
            this.providerRegistry.activeProvider();

            // Skip during generation: messages() also fires per streaming
            // chunk, and re-counting the same templates per chunk is pure
            // waste. Effect re-runs once status flips back to idle.
            if (status === 'generating') return;

            const renderCtx = this.buildLightContext(messages);
            void this.recomputeInjectionTokens({ action, protocolR, protocolN, protocolS }, renderCtx, lang);
        });

        effect(() => {
            // Build the ctx synchronously inside the effect so all the
            // signals it reads (loadedFiles, kbCacheName, dynamic injections,
            // engineMode, smartContextTurns, contextMode, etc.) become
            // tracked dependencies — reads inside the setTimeout body
            // would not, and getLLMHistorySegments could silently start
            // ignoring future inputs without anyone noticing.
            const messages = this.state.messages();
            this.configService.activeProfile();
            this.providerRegistry.activeProvider();
            const status = this.state.status();

            // While generating, the last model message's `usage` AND `content`
            // are populated piecewise per streaming chunk — `m.usage != null`
            // can't distinguish "fully committed" from "mid-stream". Skip
            // the whole recompute path until status returns to idle. The
            // effect refires on the status flip and queues exactly one
            // post-stream recompute.
            if (status === 'generating') return;

            const ctx = this.buildLightContext(messages);

            if (this.historyDebounceHandle !== null) {
                clearTimeout(this.historyDebounceHandle);
            }
            this.historyDebounceHandle = setTimeout(() => {
                this.historyDebounceHandle = null;
                void this.recomputeHistoryTokens(ctx);
            }, ContextCompositionService.HISTORY_DEBOUNCE_MS);
        });
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
            console.warn('[ContextComposition] countTokens failed:', err);
            return 0;
        }
    }

    private countText(text: string): Promise<number> {
        if (!text) return Promise.resolve(0);
        return this.countContents([{ role: 'user', parts: [{ text }] }]);
    }

    private async recomputeSystemTokens(text: string): Promise<void> {
        const seq = ++this.systemComputeSeq;
        const count = await this.countText(text);
        if (seq !== this.systemComputeSeq) return;
        this.systemPromptTokens.set(count);
    }

    private async recomputeInjectionTokens(
        parts: { action: string; protocolR: string; protocolN: string; protocolS: string; },
        ctx: BuildContext,
        lang: string
    ): Promise<void> {
        const seq = ++this.injectionComputeSeq;
        // Render the same `{{HISTORICAL_CORRECTION_RULE}}` slot the engine
        // will substitute at call time, so the count tracks what's actually
        // sent. Other tail slots ({{USER_INPUT}}, {{CORRECTION_REMINDER}},
        // {{IDEAL_OUTCOME_CONSTRAINT}}) carry user-input-bound text that
        // can't be predicted ahead of the user typing — left alone, with
        // the buffer floor absorbing the residual.
        const correctionRule = this.contextBuilder.getHistoricalCorrectionRule(ctx, lang);
        const fillRule = (template: string): string =>
            template ? template.split('{{HISTORICAL_CORRECTION_RULE}}').join(correctionRule) : '';

        // Mirror `buildResolverUserMessage`'s `${action}\n\n${protocol}`
        // join so the count covers boundary-tokenization the same way the
        // provider sees it. Counting action and protocol independently and
        // summing under-reports the merged form by the boundary tokens
        // (typically negligible but not free, esp. on BPE tokenizers that
        // can fuse newline + leading punctuation).
        const join = (action: string, protocol: string): string => {
            const filled = fillRule(protocol);
            if (action && filled) return `${action}\n\n${filled}`;
            return action || filled;
        };

        // Resolver & single carry the action template at the user-message tail
        // alongside the matching protocol; narrator never sees the action
        // template because its input is the synthetic narrator message.
        const [resolverCombined, narratorOnly, singleCombined] = await Promise.all([
            this.countText(join(parts.action, parts.protocolR)),
            this.countText(fillRule(parts.protocolN)),
            this.countText(join(parts.action, parts.protocolS))
        ]);
        if (seq !== this.injectionComputeSeq) return;
        this.injectionResolverTokens.set(resolverCombined);
        this.injectionNarratorTokens.set(narratorOnly);
        this.injectionSingleTokens.set(singleCombined);
    }

    private async recomputeHistoryTokens(ctx: BuildContext): Promise<void> {
        const seq = ++this.historyComputeSeq;
        const { compressed, recent } = this.contextBuilder.getLLMHistorySegments(ctx);
        const [compressedCount, recentCount] = await Promise.all([
            this.countContents(compressed),
            this.countContents(recent)
        ]);

        if (seq !== this.historyComputeSeq) return;
        this.historyCompressedTokens.set(compressedCount);
        this.historyRecentTokens.set(recentCount);
    }

    /**
     * Minimal BuildContext for `getLLMHistorySegments` — that method only
     * reads messages / contextMode / smartContextTurns. Other fields are
     * filled with safe defaults so we don't have to thread the full snapshot
     * through.
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
