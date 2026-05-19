import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { AppConfigStore } from './app-config-store';
import { KnowledgeService } from './knowledge.service';
import { ChatMessage, ExtendedPart } from '../models/types';
import { LLMContent, LLMPart, LLMGenerateConfig, LLMProvider, LLMProviderCapabilities } from '@hcs/llm-core';
import { LLM_MARKERS, getResponseSchema, getIntentTags } from '../constants/engine-protocol';
import { LanguageService } from './language.service';
import { LOCALES, getLocale } from '../constants/locales';
import { GAME_INTENTS, STORY_INTENTS } from '../constants/game-intents';
import { IdealStrength, StructuredAnalysis } from '../constants/engine-protocol-structured';
import { applyIntentTag, buildResolverUserMessage, buildNarratorUserMessage } from './turn-engines/build-context-utils';
import { stripSystemMainMarker } from './profile-compat';
import { extractBaseSceneHeader, extractTimeMarkerRange } from '@app/core/utils/scene-header.util';

// Engine prompt directives (HISTORICAL_CORRECTION_RULE, IDEAL_OUTCOME_CONSTRAINT)
// live in the locale files under `enginePromptDirectives`. Engine behaviour,
// not profile style — both built-in and user profiles share these.

/**
 * Per-call snapshot of every game-state value the context builder reads.
 *
 * Caller (game-engine, chat-input preview path) captures this once at turn /
 * preview dispatch time, so each ContextBuilder method runs as a function
 * over its inputs — no signal re-read mid-call, and specs can drive the
 * builder by handing it a literal `BuildContext` instead of substituting
 * `GameStateService` / `LLMProviderRegistryService`.
 *
 * The preview-only fields (`modelId`, `outputLanguage`, `provider`) are
 * optional because the engine path goes through `TurnRunInput` and never
 * re-enters `getPreviewPayload`.
 */
export interface BuildContext {
    // History assembly
    messages: ChatMessage[];
    contextMode: 'smart' | 'full' | 'summarized';
    saveContextMode: 'smart' | 'full' | 'summarized';
    smartContextTurns: number;

    // System instruction + KB sources
    systemInstructionCache: string;
    loadedFiles: Map<string, string>;

    // Cache-aware "should the KB be embedded in systemInstruction" decision
    kbCacheName: string | null;
    providerCapabilities: LLMProviderCapabilities;

    // Active profile's dynamic injections — captured up-front so the resolver
    // protocol path doesn't see a half-applied edit if the user toggles a
    // profile mid-turn.
    dynamicAction: string;
    dynamicContinue: string;
    dynamicFastforward: string;
    dynamicSystem: string;
    dynamicSave: string;
    dynamicProtocolResolver: string;
    dynamicProtocolNarrator: string;
    dynamicProtocolSingle: string;
    dynamicCorrection: string;

    // Caller-side dispatch hints (read by GameEngineService, not by ContextBuilder).
    // Kept on the snapshot so a mid-turn config edit can't make the dispatch
    // and the resolver/narrator paths disagree about engine mode.
    engineMode: 'single' | 'two-call';

    // Preview path only — engine path goes through TurnRunInput so these
    // never need to be set there.
    modelId?: string;
    outputLanguage?: string;
    provider?: LLMProvider;
}

@Injectable({
    providedIn: 'root'
})
export class ContextBuilderService {
    private kb = inject(KnowledgeService);
    private lang = inject(LanguageService);
    private state = inject(GameStateService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private appConfig = inject(AppConfigStore);

    /**
     * Gets the effective system instruction, replacing placeholders and adding language overrides.
     * @param includeKB Whether to append the full Knowledge Base text to the system prompt.
     */
    public getEffectiveSystemInstruction(ctx: BuildContext, includeKB = false): string {
        // The version marker is loader-only metadata; strip before sending
        // to the LLM. No-op for legacy v1 forks that lack the marker.
        let base = stripSystemMainMarker(ctx.systemInstructionCache);
        if (includeKB) {
            const kbText = this.kb.buildKnowledgeBaseText(ctx.loadedFiles);
            if (kbText) {
                base += '\n\n' + LLM_MARKERS.FILE_CONTENT_SEPARATOR + '\n' + kbText;
            }
        }
        return base;
    }

    /**
     * True when the active provider's cache holds the KB on the server (so the
     * client should OMIT the KB from `systemInstruction`) AND a cache is
     * currently in use. False when there's no cache, or when the provider is a
     * prefix-matched KV cache that requires the KB to be sent every turn.
     *
     * Centralized here so single-call, two-call resolver, and two-call narrator
     * all agree — historically the same `hasCache && bakesContent` expression
     * was inlined in each engine.
     */
    public shouldOmitKbFromSystemInstruction(ctx: BuildContext): boolean {
        const hasCache = !!ctx.kbCacheName;
        if (!hasCache) return false;
        const bakesContent = ctx.providerCapabilities.cacheBakesContent ?? true;
        return bakesContent;
    }

    /**
     * Constructs the JSON payload that will be sent to the Gemini API for preview purposes.
     */
    public getPreviewPayload(ctx: BuildContext, userText: string, options?: { intent?: string }) {
        const userMsgContent = (options?.intent || '') + this.stripSavePoints(userText);

        const history = this.getLLMHistory(ctx); // This is the history BEFORE the new message
        const finalUserText = this.wrapUserMessage(userMsgContent, history);

        let finalContent: LLMContent[] = [...history, { role: 'user', parts: [{ text: finalUserText }] }];

        // Allow provider to customize preview
        if (ctx.provider?.getPreview) {
            finalContent = ctx.provider.getPreview(finalContent);
        }

        const modelId = ctx.modelId || ctx.provider?.getDefaultModelId() || 'gemini-prod';

        // Construct the generation config
        const generationConfig: LLMGenerateConfig = {
            responseMimeType: 'application/json',
            responseSchema: getResponseSchema(ctx.outputLanguage)
        };

        const cachedContentName = ctx.kbCacheName || undefined;
        if (cachedContentName) {
            generationConfig.cachedContentName = cachedContentName;
        }

        const bakesContent = ctx.providerCapabilities.cacheBakesContent ?? true;
        const includeKB = !(cachedContentName && bakesContent); // Include KB unless cache stores content server-side
        return {
            model: modelId,
            contents: finalContent,
            config: generationConfig,
            systemInstruction: this.getEffectiveSystemInstruction(ctx, includeKB)
        };
    }

    /**
     * Ensures the ACT header is present in the outgoing message if not already in history.
     * This is a fallback for edge cases; the primary insertion happens in getLLMHistory.
     */
    public wrapUserMessage(text: string, history: LLMContent[]): string {
        const hasHeader = history.some(m => m.parts.some(p => p.text?.includes('--- ACT START ---')));

        if (!hasHeader) {
            // This fallback should rarely trigger if getLLMHistory works correctly
            const header = this.lang.locale().actHeader.trim();
            return header + '\n\n' + text;
        }
        return text;
    }

    /**
     * Constructs the chat history in a provider-agnostic format.
     * Handles smart context consolidation and Knowledge Base injection.
     * @param forceFullContext Whether to force full context inclusion (e.g. for saves).
     * @param filter Optional predicate to filter messages.
     * @returns Array of Content objects.
     */
    public getLLMHistory(ctx: BuildContext, forceFullContext = false, filter?: (m: ChatMessage) => boolean): LLMContent[] {
        const { compressed, recent } = this.getLLMHistorySegments(ctx, forceFullContext, filter);
        return [...compressed, ...recent];
    }

    /**
     * Same composition as {@link getLLMHistory} but returns the two halves
     * separately so callers (e.g. the sidebar context-composition view) can
     * tokenize them independently. `compressed` holds full smart-context
     * summary blocks; `recent` holds the verbatim recent window with the
     * leftover (partial) summary block and ACT header fused in.
     *
     * `[...compressed, ...recent]` is byte-for-byte identical to
     * `getLLMHistory`'s output.
     */
    public getLLMHistorySegments(ctx: BuildContext, forceFullContext = false, filter?: (m: ChatMessage) => boolean): { compressed: LLMContent[]; recent: LLMContent[] } {
        const all = ctx.messages;

        // Use custom filter or default: Filter out RefOnly, but keep tool responses
        const defaultFilter = (m: ChatMessage) => !m.isRefOnly || m.parts?.some(p => p.functionResponse);
        const filtered = all.filter(filter || defaultFilter);

        // We want to keep the last few messages intact for immediate context flow.
        let RECENT_WINDOW = 20;

        // Use full context if forced (e.g., save commands) or if contextMode is 'full'
        const mode = forceFullContext ? ctx.saveContextMode : ctx.contextMode;

        const useFullContext = mode === 'full';
        if (mode === 'summarized') {
            RECENT_WINDOW = 2;
        } else if (mode === 'smart') {
            RECENT_WINDOW = ctx.smartContextTurns * 2;
        }

        const splitIndex = useFullContext ? 0 : Math.max(0, filtered.length - RECENT_WINDOW);

        const pastMessages = filtered.slice(0, splitIndex);
        const recentMessages = filtered.slice(splitIndex);


        // 1. Process Past Summaries into Layered Blocks
        const summaryBlocks: LLMContent[] = [];
        const SUMMARY_BLOCK_SIZE = 10;
        let actHeaderInserted = false;
        const actHeader = this.lang.locale().actHeader.trim();

        let currentBlockText = '';
        let modelCountInCurrentBlock = 0;

        if (!useFullContext && pastMessages.length > 0) {

            pastMessages.forEach((m) => {
                if (m.role === 'model') {
                    const stateUpdates: string[] = this.getDetailFields(m);

                    if (stateUpdates.length > 0) {
                        const baseHeader = extractBaseSceneHeader(m.content);
                        const timeHeader = extractTimeMarkerRange(m.content);
                        // If base is itself a `[T …]` bracket, the time range
                        // already covers it — drop base to avoid emitting
                        // `[T 12:00] [T 12:00~T 13:00]`. Regex (not
                        // `startsWith`) so leading whitespace inside the
                        // bracket (`[ T 12:42]`, allowed by SCENE_HEADER_RE)
                        // still gets caught.
                        const finalHeader = (timeHeader && /^\[\s*T/.test(baseHeader))
                            ? timeHeader
                            : [baseHeader, timeHeader].filter(h => !!h).join(' ');
                        currentBlockText += (finalHeader ? `${finalHeader} ` : '') + `---\n${stateUpdates.join('\n')}\n---\n`;
                        modelCountInCurrentBlock++;

                        // If block is full, push as a stable message
                        if (modelCountInCurrentBlock >= SUMMARY_BLOCK_SIZE) {
                            summaryBlocks.push({ role: 'user', parts: [{ text: currentBlockText }] });
                            currentBlockText = '';
                            modelCountInCurrentBlock = 0;
                        }
                    }
                }
            });

            // NEW: Only push FULL blocks to ensure they stay 100% static for caching
            // Any leftovers will be handled separately in the dynamic section

            // Note: actHeader should still be handled. We'll prepend it to the first available block
            // or the first recent message later.
            if (summaryBlocks.length > 0) {
                const firstPart = summaryBlocks[0].parts[0];
                firstPart.text = actHeader + '\n' + (firstPart.text || '');
                actHeaderInserted = true;
            }
        }

        // 2. Build Recent History (Standard Format)
        const leftoverSummary = currentBlockText; // From the closure above
        let finalActHeaderInserted = actHeaderInserted;
        const llmHistory: LLMContent[] = recentMessages.map((m, idx) => {
            const parts: LLMPart[] = [];

            if (m.parts && m.parts.length > 0) {
                m.parts.forEach(p => {
                    if ((p as ExtendedPart).thought && !(p as ExtendedPart).thoughtSignature) return;
                    if (p.text && p.text.startsWith(LLM_MARKERS.FILE_CONTENT_SEPARATOR)) return;
                    if (p.text && p.text.startsWith(LLM_MARKERS.SYSTEM_RULE_SEPARATOR)) return;

                    if (p.text) {
                        parts.push({ ...p, text: this.stripSavePoints(p.text) });
                    } else {
                        parts.push({ ...p });
                    }
                });
            }
            if (parts.length === 0 && m.content) {
                parts.push({ text: this.stripSavePoints(m.content) });
            }

            if (m.role === 'model') {
                const turnUpdateParts: string[] = this.getDetailFields(m);
                if (turnUpdateParts.length > 0) {
                    let lastTextPartIndex = -1;
                    for (let i = parts.length - 1; i >= 0; i--) {
                        if (parts[i].text !== undefined && !(parts[i] as ExtendedPart).thought) {
                            lastTextPartIndex = i;
                            break;
                        }
                    }

                    if (lastTextPartIndex !== -1) {
                        parts[lastTextPartIndex] = {
                            ...parts[lastTextPartIndex],
                            text: parts[lastTextPartIndex].text + '\n\n---\n' + turnUpdateParts.join('\n') + '\n---'
                        };
                    } else {
                        parts.push({ text: '\n---\n' + turnUpdateParts.join('\n') + '\n---' });
                    }
                }
            }

            if (!finalActHeaderInserted && this.isLastSceneMessage(recentMessages[idx])) {
                let lastTextPartIndex = -1;
                for (let i = parts.length - 1; i >= 0; i--) {
                    if (parts[i].text !== undefined && !(parts[i] as ExtendedPart).thought) {
                        lastTextPartIndex = i;
                        break;
                    }
                }
                if (lastTextPartIndex !== -1) {
                    parts[lastTextPartIndex] = {
                        ...parts[lastTextPartIndex],
                        text: parts[lastTextPartIndex].text + '\n\n' + actHeader
                    };
                } else {
                    parts.push({ text: actHeader });
                }
                finalActHeaderInserted = true;
            }

            return { role: m.role, parts };
        });

        // 3. Assemble: [KB] + [Stable Summary Blocks] + [Leftover Summaries + Recent History]
        // Prepend leftover (dynamic) summary to the first recent message
        if (leftoverSummary.trim()) {
            if (llmHistory.length > 0) {
                const firstRecent = llmHistory[0];
                // Ensure actHeader is there if not yet inserted
                const prefix = (!finalActHeaderInserted ? actHeader + '\n' : '');

                const targetPart = firstRecent.parts.find(p => p.text !== undefined) || firstRecent.parts[0];
                if (targetPart && targetPart.text !== undefined) {
                    targetPart.text = prefix + leftoverSummary + targetPart.text;
                } else {
                    firstRecent.parts.unshift({ text: prefix + leftoverSummary });
                }
                if (prefix) finalActHeaderInserted = true;
            } else {
                // Rare case: No recent messages, just push the leftover
                const prefix = (!finalActHeaderInserted ? actHeader + '\n' : '');
                llmHistory.push({ role: 'user', parts: [{ text: prefix + leftoverSummary }] });
                if (prefix) finalActHeaderInserted = true;
            }
        } else if (!finalActHeaderInserted && llmHistory.length > 0) {
            // No leftover summary, but still need to insert actHeader somewhere if not yet done
            const firstRecent = llmHistory[0];
            const targetPart = firstRecent.parts.find(p => p.text !== undefined) || firstRecent.parts[0];
            if (targetPart && targetPart.text !== undefined) {
                targetPart.text = actHeader + '\n' + targetPart.text;
            } else {
                firstRecent.parts.unshift({ text: actHeader + '\n' });
            }
            finalActHeaderInserted = true;
        }

        if (summaryBlocks.length > 0) {
            console.log(`[ContextBuilder] Created ${summaryBlocks.length} summary blocks for ${pastMessages.length} past messages.`);
        }

        // KB is now handled in systemInstruction for better Implicit Caching stability.

        return { compressed: summaryBlocks, recent: llmHistory };
    }


    private getDetailFields(m: ChatMessage): string[] {
        const stateUpdates: string[] = [];
        const isStoryIntent = m.intent && (STORY_INTENTS as string[]).includes(m.intent);

        if (isStoryIntent) {
            if (m.summary) stateUpdates.push(`summary: ${m.summary}`);
        } else {
            // For system/save, use the actual content/story
            if (m.content) stateUpdates.push(`story: ${this.stripSavePoints(m.content)}`);
        }
        if (m.inventory_log && m.inventory_log.length > 0) {
            stateUpdates.push(`inventory_log:${JSON.stringify(m.inventory_log)}`);
        }
        if (m.quest_log && m.quest_log.length > 0) {
            stateUpdates.push(`quest_log:${JSON.stringify(m.quest_log)}`);
        }
        if (m.character_log && m.character_log.length > 0) {
            stateUpdates.push(`character_log:${JSON.stringify(m.character_log)}`);
        }
        if (m.world_log && m.world_log.length > 0) {
            stateUpdates.push(`world_log:${JSON.stringify(m.world_log)}`);
        }
        if (m.correction && m.correction.trim()) {
            stateUpdates.push(`correction: ${m.correction.trim()}`);
        }
        return stateUpdates;
    }

    /**
     * Helper to identify if a message is the 'last scene' model message.
     * This is the model's initialization response where the ACT header should be appended.
     */
    private isLastSceneMessage(m: ChatMessage): boolean {
        return Object.values(LOCALES).some(l => {
            return m.role === 'model' && m.analysis === l.engineStrings.LOCAL_INIT_ANALYSIS;
        });
    }

    private stripSavePoints(text: string): string {
        if (!text) return '';
        return text.replace(/<possible save point>/gi, '');
    }

    /**
     * Returns the correction text iff the most recent model message is a
     * `<系統>` correction declaration (`intent === SYSTEM` with non-empty
     * `correction`). Story-intent messages may carry transplanted correction
     * for Layer 1 long-term propagation via stateUpdates summaries, but the
     * Layer 2 `{{CORRECTION_REMINDER}}` slot is one-shot — fires only on the
     * immediate auto-resend turn.
     */
    public getRecentCorrection(ctx: BuildContext): string {
        for (let i = ctx.messages.length - 1; i >= 0; i--) {
            const m = ctx.messages[i];
            if (m.role !== 'model') continue;
            if (m.intent !== GAME_INTENTS.SYSTEM) return '';
            return m.correction?.trim() ?? '';
        }
        return '';
    }

    /**
     * Renders the correction reminder block by filling `{{CORRECTION_TEXT}}`
     * in the active profile's `injection_correction.md`. Returns '' when
     * there's no correction or the template is missing (legacy profile).
     */
    public renderCorrectionReminder(ctx: BuildContext, correction: string): string {
        if (!correction) return '';
        const template = ctx.dynamicCorrection;
        if (!template) return '';
        return template.replace(/\{\{CORRECTION_TEXT\}\}/g, () => correction);
    }

    /**
     * True when chat history (post-ref-only filter, since that's what the LLM
     * sees) contains at least one model message with a non-empty `correction`
     * field. Drives the {@link getHistoricalCorrectionRule} slot fill.
     */
    public hasHistoricalCorrection(ctx: BuildContext): boolean {
        return ctx.messages.some(m =>
            m.role === 'model' && !m.isRefOnly && !!m.correction?.trim()
        );
    }

    /**
     * Returns the rule paragraph to substitute into protocol_resolver /
     * protocol_narrator's `{{HISTORICAL_CORRECTION_RULE}}` slot, or '' when
     * no correction lives in active history. The rule is engine behaviour,
     * not profile style — same text for cloud and local profiles.
     */
    public getHistoricalCorrectionRule(ctx: BuildContext, lang: string): string {
        if (!this.hasHistoricalCorrection(ctx)) return '';
        return getLocale(lang).enginePromptDirectives.HISTORICAL_CORRECTION_RULE;
    }

    /**
     * Returns the trimmed `userIdealOutcome` of the most recent user message, or
     * '' when absent / blank. Drives the {@link getIdealOutcomeConstraint} slot.
     */
    public getRecentUserIdealOutcome(ctx: BuildContext): string {
        for (let i = ctx.messages.length - 1; i >= 0; i--) {
            const m = ctx.messages[i];
            if (m.role !== 'user') continue;
            return m.userIdealOutcome?.trim() ?? '';
        }
        return '';
    }

    /**
     * Returns the rule paragraph to substitute into protocol_resolver's
     * `{{IDEAL_OUTCOME_CONSTRAINT}}` slot, or '' when the user did not supply
     * one. Plain `.split/.join` avoids backreference reinterpretation of the
     * user-supplied text (which can contain `$&` / `$1` legitimately).
     */
    public getIdealOutcomeConstraint(text: string, lang: string): string {
        if (!text) return '';
        const template = getLocale(lang).enginePromptDirectives.IDEAL_OUTCOME_CONSTRAINT_TEMPLATE;
        return template.split('{0}').join(text);
    }

    /**
     * Resolves the per-intent dynamic injection text from the snapshot.
     * Centralized so the resolver tail (this method's caller) and the
     * single-call augmentation in GameEngineService agree on the mapping.
     */
    public intentInjection(ctx: BuildContext, intent: string): string {
        switch (intent) {
            case GAME_INTENTS.ACTION: return ctx.dynamicAction;
            case GAME_INTENTS.CONTINUE: return ctx.dynamicContinue;
            case GAME_INTENTS.FAST_FORWARD: return ctx.dynamicFastforward;
            case GAME_INTENTS.SYSTEM: return ctx.dynamicSystem;
            case GAME_INTENTS.SAVE: return ctx.dynamicSave;
            default: return '';
        }
    }

    /**
     * Builds the LLM history for the two-call resolver call (Call 1).
     *
     * The cache prefix (system instruction + KB) is shared with the single-call
     * path; the resolver-specific protocol rides at the user-message tail along
     * with the intent injection. Both `{{USER_INPUT}}` placeholders are
     * substituted with the (intent-tagged) user input.
     *
     * Caller passes `baseHistory` from {@link getLLMHistory}; this method
     * pops the last user message, augments it, and pushes it back. Returns a
     * new array — the input is not mutated.
     */
    public buildResolverContext(ctx: BuildContext, options: { baseHistory: LLMContent[]; intent: string; lang: string }): LLMContent[] {
        const history = options.baseHistory.slice();
        const lastMsg = history.pop();
        if (!lastMsg || !lastMsg.parts || typeof lastMsg.parts[0]?.text !== 'string') {
            if (lastMsg) history.push(lastMsg);
            return history;
        }

        const userInput = applyIntentTag(lastMsg.parts[0].text, options.intent, getIntentTags(options.lang));

        const intentInjection = this.intentInjection(ctx, options.intent);

        const protocolResolver = ctx.dynamicProtocolResolver
            .replace(/\{\{HISTORICAL_CORRECTION_RULE\}\}/g, () => this.getHistoricalCorrectionRule(ctx, options.lang));

        const tail = buildResolverUserMessage({
            userInput,
            intentInjection,
            protocolResolver,
            correctionReminder: this.renderCorrectionReminder(ctx, this.getRecentCorrection(ctx)),
            idealOutcomeConstraint: this.getIdealOutcomeConstraint(this.getRecentUserIdealOutcome(ctx), options.lang)
        });
        const finalContent = this.wrapUserMessage(tail, history);

        history.push({ role: 'user', parts: [{ text: finalContent }] });
        return history;
    }

    /**
     * Builds the LLM history for the two-call narrator call (Call 2).
     *
     * The narrator MUST NOT see the original user input — narration must
     * derive purely from the executed steps and the interrupted hint, so
     * unexecuted dialogue/actions cannot smuggle through. This method pops
     * the last user message (raw player input) and replaces it with a
     * synthetic narrator-input message containing the structured resolver
     * output plus the protocol_narrator injection.
     *
     * Earlier history (prior turns, ACT header, summaries) is preserved.
     */
    public buildNarratorContext(ctx: BuildContext, options: {
        baseHistory: LLMContent[];
        idealOutcome: string;
        idealStrength: IdealStrength;
        truncatedAnalysis: StructuredAnalysis;
        lang: string;
    }): LLMContent[] {
        const history = options.baseHistory.slice();
        history.pop();

        const protocolNarrator = ctx.dynamicProtocolNarrator
            .replace(/\{\{HISTORICAL_CORRECTION_RULE\}\}/g, () => this.getHistoricalCorrectionRule(ctx, options.lang));

        const tail = buildNarratorUserMessage({
            idealOutcome: options.idealOutcome,
            idealStrength: options.idealStrength,
            truncatedAnalysis: options.truncatedAnalysis,
            protocolNarrator,
            correction: this.getRecentCorrection(ctx)
        });
        const finalContent = this.wrapUserMessage(tail, history);

        history.push({ role: 'user', parts: [{ text: finalContent }] });
        return history;
    }

    /**
     * Captures every signal the context builder reads, in one shot. The
     * returned object is what each ContextBuilder method now operates on
     * — caller never re-enters state mid-call. Used by both the engine path
     * (sendMessage) and the live preview path (chat-input).
     */
    snapshotForTurn(): BuildContext {
        const provider = this.providerRegistry.getActive();
        // Defensive default for `cacheBakesContent` matches the historical
        // `?? true` fallback. The engine path itself throws on a null provider
        // before constructing TurnRunInput, so this default only fires on the
        // preview path's edge case.
        const providerCapabilities = provider?.getCapabilities()
            ?? ({ cacheBakesContent: true } as LLMProviderCapabilities);
        return {
            messages: this.state.messages(),
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
            engineMode: this.appConfig.engineMode(),
            modelId: this.providerRegistry.getActiveModelId() || undefined,
            outputLanguage: this.appConfig.outputLanguage(),
            provider: provider ?? undefined
        };
    }

    /**
     * Single-call sibling to `buildResolverContext` / `buildNarratorContext`:
     * augments the base history's last user message with intent injection +
     * protocol_single (both with `{{USER_INPUT}}` substituted).
     */
    augmentSingleCallHistory(ctx: BuildContext, baseHistory: LLMContent[], currentIntent: string, lang: string): LLMContent[] {
        const history = baseHistory.slice();

        const injectionContent = this.intentInjection(ctx, currentIntent);
        if (!injectionContent || history.length === 0) return history;

        const lastMsg = history.pop();
        if (!lastMsg || !lastMsg.parts || typeof lastMsg.parts[0]?.text !== 'string') {
            if (lastMsg) history.push(lastMsg);
            return history;
        }

        const tags = getIntentTags(lang);
        const intentTagMap: Record<string, string> = {
            [GAME_INTENTS.ACTION]: tags.ACTION,
            [GAME_INTENTS.CONTINUE]: tags.CONTINUE,
            [GAME_INTENTS.FAST_FORWARD]: tags.FAST_FORWARD,
            [GAME_INTENTS.SYSTEM]: tags.SYSTEM,
            [GAME_INTENTS.SAVE]: tags.SAVE,
        };
        let userInput = lastMsg.parts[0].text;
        const tag = intentTagMap[currentIntent] ?? '';
        if (tag && !userInput.trim().startsWith(tag)) {
            userInput = tag + userInput;
        }

        console.log(`[ContextBuilder] Injecting Dynamic Prompt for ${currentIntent}`);
        // Function-form replace so a literal `$&` / `$1` in userInput is not
        // interpreted as a backreference pattern. Correction reminder fills
        // first so its rendered text can itself contain `{{USER_INPUT}}`-like
        // sequences without bleeding into the next pass.
        const correctionReminder = this.renderCorrectionReminder(ctx, this.getRecentCorrection(ctx));
        const idealOutcomeConstraint = this.getIdealOutcomeConstraint(this.getRecentUserIdealOutcome(ctx), lang);
        const mergedContent = injectionContent
            .replace(/\{\{CORRECTION_REMINDER\}\}/g, () => correctionReminder)
            .replace(/\{\{USER_INPUT\}\}/g, () => userInput);
        const protocolSingle = ctx.dynamicProtocolSingle
            .replace(/\{\{IDEAL_OUTCOME_CONSTRAINT\}\}/g, () => idealOutcomeConstraint)
            .replace(/\{\{USER_INPUT\}\}/g, () => userInput);
        const withProtocol = protocolSingle ? `${mergedContent}\n\n${protocolSingle}` : mergedContent;
        const finalContent = this.wrapUserMessage(withProtocol, history);

        history.push({ role: 'user', parts: [{ text: finalContent }] });
        return history;
    }
}
