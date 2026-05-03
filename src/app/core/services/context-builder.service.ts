import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { KnowledgeService } from './knowledge.service';
import { ChatMessage, ExtendedPart } from '../models/types';
import { LLMContent, LLMPart, LLMGenerateConfig } from '@hcs/llm-core';
import { LLM_MARKERS, getResponseSchema, getIntentTags } from '../constants/engine-protocol';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LanguageService } from './language.service';
import { LOCALES, getLocale } from '../constants/locales';
import { GAME_INTENTS, STORY_INTENTS } from '../constants/game-intents';
import { ResolverOutput, ResolverStep } from '../constants/engine-protocol-two-call';
import { applyIntentTag, buildResolverUserMessage, buildNarratorUserMessage } from './turn-engines/build-context-utils';
import { stripSystemMainMarker } from './profile-compat';

// Engine prompt directives (HISTORICAL_CORRECTION_RULE, IDEAL_OUTCOME_CONSTRAINT)
// live in the locale files under `enginePromptDirectives`. Engine behaviour,
// not profile style — both built-in and user profiles share these.

@Injectable({
    providedIn: 'root'
})
export class ContextBuilderService {
    private state = inject(GameStateService);
    private kb = inject(KnowledgeService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private lang = inject(LanguageService);

    private get provider() {
        return this.providerRegistry.getActive();
    }

    /**
     * Gets the effective system instruction, replacing placeholders and adding language overrides.
     * @param includeKB Whether to append the full Knowledge Base text to the system prompt.
     */
    public getEffectiveSystemInstruction(includeKB = false): string {
        // The version marker is loader-only metadata; strip before sending
        // to the LLM. No-op for legacy v1 forks that lack the marker.
        let base = stripSystemMainMarker(this.state.systemInstructionCache());
        if (includeKB) {
            const kbText = this.kb.buildKnowledgeBaseText(this.state.loadedFiles());
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
    public shouldOmitKbFromSystemInstruction(): boolean {
        const hasCache = !!this.state.kbCacheName();
        if (!hasCache) return false;
        const bakesContent = this.provider?.getCapabilities().cacheBakesContent ?? true;
        return bakesContent;
    }

    /**
     * Constructs the JSON payload that will be sent to the Gemini API for preview purposes.
     */
    public getPreviewPayload(userText: string, options?: { intent?: string }) {
        const userMsgContent = (options?.intent || '') + this.stripSavePoints(userText);

        const history = this.getLLMHistory(); // This is the history BEFORE the new message
        const finalUserText = this.wrapUserMessage(userMsgContent, history);

        let finalContent: LLMContent[] = [...history, { role: 'user', parts: [{ text: finalUserText }] }];

        // Allow provider to customize preview
        if (this.provider?.getPreview) {
            finalContent = this.provider.getPreview(finalContent);
        }

        const config = this.state.config();
        const modelId = config?.modelId || this.provider?.getDefaultModelId() || 'gemini-prod';

        // Construct the generation config
        const generationConfig: LLMGenerateConfig = {
            responseMimeType: 'application/json',
            responseSchema: getResponseSchema(config?.outputLanguage)
        };

        const cachedContentName = this.state.kbCacheName() || undefined;
        if (cachedContentName) {
            generationConfig.cachedContentName = cachedContentName;
        }

        const bakesContent = this.provider?.getCapabilities().cacheBakesContent ?? true;
        const includeKB = !(cachedContentName && bakesContent); // Include KB unless cache stores content server-side
        return {
            model: modelId,
            contents: finalContent,
            config: generationConfig,
            systemInstruction: this.getEffectiveSystemInstruction(includeKB)
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
    public getLLMHistory(forceFullContext = false, filter?: (m: ChatMessage) => boolean): LLMContent[] {
        const all = this.state.messages();

        // Use custom filter or default: Filter out RefOnly, but keep tool responses
        const defaultFilter = (m: ChatMessage) => !m.isRefOnly || m.parts?.some(p => p.functionResponse);
        const filtered = all.filter(filter || defaultFilter);

        // We want to keep the last few messages intact for immediate context flow.
        let RECENT_WINDOW = 20;

        // Use full context if forced (e.g., save commands) or if contextMode is 'full'
        const mode = forceFullContext ? this.state.saveContextMode() : this.state.contextMode();

        const useFullContext = mode === 'full';
        if (mode === 'summarized') {
            RECENT_WINDOW = 2;
        } else if (mode === 'smart') {
            RECENT_WINDOW = (this.state.config()?.smartContextTurns ?? 10) * 2;
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
                        const headerMatch = m.content.match(/\[\s*[^\]]*\d+[^\]]*\]/);
                        const baseHeader = headerMatch ? headerMatch[0] : '';

                        // Extract time markers
                        const tMatches = [...m.content.matchAll(/\[T\s*([^\]]+)\]/g)];
                        let timeHeader = '';
                        if (tMatches.length > 1) {
                            const start = tMatches[0][1].trim();
                            const end = tMatches[tMatches.length - 1][1].trim();
                            timeHeader = `[T ${start}~T ${end}]`;
                        } else if (tMatches.length === 1) {
                            timeHeader = tMatches[0][0];
                        }

                        const finalHeader = [baseHeader, timeHeader].filter(h => !!h).join(' ');
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
        // ... (llmHistory building remains mostly same, but we need to inject leftover summaries)
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

        // Unshift stable blocks
        llmHistory.unshift(...summaryBlocks);

        if (summaryBlocks.length > 0) {
            console.log(`[ContextBuilder] Created ${summaryBlocks.length} summary blocks for ${pastMessages.length} past messages.`);
        }

        // KB is now handled in systemInstruction for better Implicit Caching stability.

        return llmHistory;
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
            return m.role === 'model' && m.analysis === l.uiStrings.LOCAL_INIT_ANALYSIS;
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
    public getRecentCorrection(): string {
        const messages = this.state.messages();
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
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
    public renderCorrectionReminder(correction: string): string {
        if (!correction) return '';
        const template = this.state.dynamicCorrectionInjection();
        if (!template) return '';
        return template.replace(/\{\{CORRECTION_TEXT\}\}/g, () => correction);
    }

    /**
     * True when chat history (post-ref-only filter, since that's what the LLM
     * sees) contains at least one model message with a non-empty `correction`
     * field. Drives the {@link getHistoricalCorrectionRule} slot fill.
     */
    public hasHistoricalCorrection(): boolean {
        return this.state.messages().some(m =>
            m.role === 'model' && !m.isRefOnly && !!m.correction?.trim()
        );
    }

    /**
     * Returns the rule paragraph to substitute into protocol_resolver /
     * protocol_narrator's `{{HISTORICAL_CORRECTION_RULE}}` slot, or '' when
     * no correction lives in active history. The rule is engine behaviour,
     * not profile style — same text for cloud and local profiles.
     */
    public getHistoricalCorrectionRule(lang: string): string {
        if (!this.hasHistoricalCorrection()) return '';
        return getLocale(lang).enginePromptDirectives.HISTORICAL_CORRECTION_RULE;
    }

    /**
     * Returns the trimmed `userIdealOutcome` of the most recent user message, or
     * '' when absent / blank. Drives the {@link getIdealOutcomeConstraint} slot.
     */
    public getRecentUserIdealOutcome(): string {
        const messages = this.state.messages();
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
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
    public buildResolverContext(options: { baseHistory: LLMContent[]; intent: string; lang: string }): LLMContent[] {
        const history = options.baseHistory.slice();
        const lastMsg = history.pop();
        if (!lastMsg || !lastMsg.parts || typeof lastMsg.parts[0]?.text !== 'string') {
            if (lastMsg) history.push(lastMsg);
            return history;
        }

        const userInput = applyIntentTag(lastMsg.parts[0].text, options.intent, getIntentTags(options.lang));

        let intentInjection = '';
        switch (options.intent) {
            case GAME_INTENTS.ACTION: intentInjection = this.state.dynamicActionInjection(); break;
            case GAME_INTENTS.CONTINUE: intentInjection = this.state.dynamicContinueInjection(); break;
            case GAME_INTENTS.FAST_FORWARD: intentInjection = this.state.dynamicFastforwardInjection(); break;
            case GAME_INTENTS.SYSTEM: intentInjection = this.state.dynamicSystemInjection(); break;
            case GAME_INTENTS.SAVE: intentInjection = this.state.dynamicSaveInjection(); break;
        }

        const protocolResolver = this.state.dynamicProtocolResolverInjection()
            .replace(/\{\{HISTORICAL_CORRECTION_RULE\}\}/g, () => this.getHistoricalCorrectionRule(options.lang));

        const tail = buildResolverUserMessage({
            userInput,
            intentInjection,
            protocolResolver,
            correctionReminder: this.renderCorrectionReminder(this.getRecentCorrection()),
            idealOutcomeConstraint: this.getIdealOutcomeConstraint(this.getRecentUserIdealOutcome(), options.lang)
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
    public buildNarratorContext(options: {
        baseHistory: LLMContent[];
        resolver: ResolverOutput;
        executedSteps: ResolverStep[];
        lang: string;
    }): LLMContent[] {
        const history = options.baseHistory.slice();
        history.pop();

        const protocolNarrator = this.state.dynamicProtocolNarratorInjection()
            .replace(/\{\{HISTORICAL_CORRECTION_RULE\}\}/g, () => this.getHistoricalCorrectionRule(options.lang));

        const tail = buildNarratorUserMessage({
            resolver: options.resolver,
            executedSteps: options.executedSteps,
            protocolNarrator,
            correction: this.getRecentCorrection()
        });
        const finalContent = this.wrapUserMessage(tail, history);

        history.push({ role: 'user', parts: [{ text: finalContent }] });
        return history;
    }
}
