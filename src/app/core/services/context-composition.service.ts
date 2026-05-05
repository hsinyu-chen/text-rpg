import { Injectable, OnDestroy, computed, effect, inject, signal } from '@angular/core';
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
export class ContextCompositionService implements OnDestroy {
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
            // Signal reads must be synchronous so Angular's effect tracking
            // sees them. The protocol/action template signals get read by
            // `buildLightContext(messages)` below — no need to read them
            // here too. Status, messages, lang, profile, provider are not
            // covered by buildLightContext and must be tracked explicitly.
            //
            // Why messages: protocol templates carry `{{HISTORICAL_CORRECTION_RULE}}`
            // and the action template carries `{{CORRECTION_REMINDER}}` —
            // both substitute against history's correction state, so the
            // count must refire when history changes.
            const messages = this.state.messages();
            const lang = this.appConfig.outputLanguage();
            const status = this.state.status();
            this.configService.activeProfile();
            this.providerRegistry.activeProvider();

            // Skip during generation: messages() also fires per streaming
            // chunk, and re-counting the same templates per chunk is pure
            // waste. Effect re-runs once status flips back to idle.
            if (status === 'generating') return;

            const ctx = this.buildLightContext(messages);
            void this.recomputeInjectionTokens(ctx, lang);
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
            // getLLMHistorySegments embeds the locale's `actHeader` into
            // either the first summary block or the first recent message.
            // LanguageService.locale is a computed off `outputLanguage`, so
            // tracking the latter here registers the chain — without this
            // read, switching language wouldn't refire the recompute and
            // historyTokens would carry the previous locale's header until
            // the next unrelated trigger.
            const status = this.state.status();
            this.appConfig.outputLanguage();

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

    /**
     * Returns the token count, or `null` when the provider is unavailable or
     * `countTokens` threw. Callers MUST treat null as "skip update, keep last
     * good value" — writing 0 on failure would mis-render the bar as nearly
     * empty and defeat the OAI-400 prediction goal exactly when the provider
     * is flakiest. Empty input legitimately counts as 0.
     */
    ngOnDestroy(): void {
        // Service is providedIn 'root' so this only fires on explicit module
        // teardown (e.g. unit tests) — but cleaning up the pending debounce
        // costs nothing and avoids logic firing on a torn-down service.
        if (this.historyDebounceHandle !== null) {
            clearTimeout(this.historyDebounceHandle);
            this.historyDebounceHandle = null;
        }
    }

    private async countContents(contents: LLMContent[]): Promise<number | null> {
        if (contents.length === 0) return 0;
        const provider = this.providerRegistry.activeProvider();
        if (!provider) return null;
        const config = this.providerRegistry.getActiveConfig();
        const modelId = this.providerRegistry.getActiveModelId() || '';
        try {
            return await provider.countTokens(config, modelId, contents);
        } catch (err) {
            console.warn('[ContextComposition] countTokens failed:', err);
            return null;
        }
    }

    private countText(text: string): Promise<number | null> {
        if (!text) return Promise.resolve(0);
        return this.countContents([{ role: 'user', parts: [{ text }] }]);
    }

    private async recomputeSystemTokens(text: string): Promise<void> {
        const seq = ++this.systemComputeSeq;
        const count = await this.countText(text);
        if (seq !== this.systemComputeSeq) return;
        // null = countTokens failed; preserve last known good value.
        if (count === null) return;
        this.systemPromptTokens.set(count);
    }

    private async recomputeInjectionTokens(ctx: BuildContext, lang: string): Promise<void> {
        const seq = ++this.injectionComputeSeq;

        // Two history-derived placeholder substitutions track what the
        // engine renders at call time:
        //
        //   {{HISTORICAL_CORRECTION_RULE}} (in protocol_resolver/narrator/single)
        //     → multi-paragraph rule text from the locale, present whenever
        //       history holds at least one model message with a correction.
        //
        //   {{CORRECTION_REMINDER}} (in action template)
        //     → renderCorrectionReminder() substitutes the most recent
        //       correction's text into dynamicCorrection. Active only on the
        //       turn immediately after a correction-declaration. Hundreds
        //       of tokens — material to "will I 400" prediction.
        //
        // Both are derived purely from history (not user-input-bound), so we
        // mirror them here. {{USER_INPUT}} and {{IDEAL_OUTCOME_CONSTRAINT}}
        // genuinely depend on the user typing the next turn — left alone,
        // residual absorbed by the buffer floor.
        const correctionRule = this.contextBuilder.getHistoricalCorrectionRule(ctx, lang);
        const correctionReminder = this.contextBuilder.renderCorrectionReminder(
            ctx, this.contextBuilder.getRecentCorrection(ctx)
        );
        const fillProtocol = (template: string): string =>
            template ? template.split('{{HISTORICAL_CORRECTION_RULE}}').join(correctionRule) : '';
        const fillAction = (template: string): string =>
            template ? template.split('{{CORRECTION_REMINDER}}').join(correctionReminder) : '';

        // Mirror `buildResolverUserMessage`'s `${action}\n\n${protocol}` join
        // so the count covers boundary-tokenization the same way the provider
        // sees it. Counting action and protocol independently and summing
        // under-reports the merged form by the boundary tokens (typically
        // negligible but not free, esp. on BPE tokenizers that can fuse
        // newline + leading punctuation).
        const filledAction = fillAction(ctx.dynamicAction);
        const join = (action: string, protocol: string): string => {
            const filled = fillProtocol(protocol);
            if (action && filled) return `${action}\n\n${filled}`;
            return action || filled;
        };

        // Each `countTokens` is a real provider round-trip — only fire the
        // ones the active engine mode will actually display via
        // `effectiveInjectionTokens`. Inactive signals retain their last
        // value, which is fine: they're only read when the engine flips
        // back to that mode, at which point this effect refires (engineMode
        // is a tracked dep via buildLightContext) and recomputes the now-
        // active counts on the fresh ctx. Brief stale window between the
        // toggle and the effect's next tick is acceptable.
        //
        // Resolver & single carry the action template at the user-message
        // tail alongside the matching protocol; narrator never sees the
        // action template because its input is the synthetic narrator
        // message. Atomic update: bail if any required count failed so the
        // bar can't render a partial composition (a fresh resolver paired
        // with a stale narrator would silently misrepresent the 2-call
        // worst case).
        if (ctx.engineMode === 'two-call') {
            const [resolverCombined, narratorOnly] = await Promise.all([
                this.countText(join(filledAction, ctx.dynamicProtocolResolver)),
                this.countText(fillProtocol(ctx.dynamicProtocolNarrator))
            ]);
            if (seq !== this.injectionComputeSeq) return;
            if (resolverCombined === null || narratorOnly === null) return;
            this.injectionResolverTokens.set(resolverCombined);
            this.injectionNarratorTokens.set(narratorOnly);
        } else {
            const singleCombined = await this.countText(join(filledAction, ctx.dynamicProtocolSingle));
            if (seq !== this.injectionComputeSeq) return;
            if (singleCombined === null) return;
            this.injectionSingleTokens.set(singleCombined);
        }
    }

    private async recomputeHistoryTokens(ctx: BuildContext): Promise<void> {
        const seq = ++this.historyComputeSeq;
        const { compressed, recent } = this.contextBuilder.getLLMHistorySegments(ctx);
        const [compressedCount, recentCount] = await Promise.all([
            this.countContents(compressed),
            this.countContents(recent)
        ]);

        if (seq !== this.historyComputeSeq) return;
        if (compressedCount === null || recentCount === null) return;
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
