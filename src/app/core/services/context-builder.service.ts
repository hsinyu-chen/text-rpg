import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { KnowledgeService } from './knowledge.service';
import { ChatMessage, ExtendedPart } from '../models/types';
import { LLMContent, LLMPart, LLMGenerateConfig } from './llm-provider';
import { LLM_MARKERS, getResponseSchema } from '../constants/engine-protocol';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LanguageService } from './language.service';
import { LOCALES } from '../constants/locales';
import { STORY_INTENTS } from '../constants/game-intents';

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
     */
    public getEffectiveSystemInstruction(): string {
        return this.state.systemInstructionCache();
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

        return {
            model: modelId,
            contents: finalContent,
            config: generationConfig,
            systemInstruction: this.getEffectiveSystemInstruction()
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
        }

        const splitIndex = useFullContext ? 0 : Math.max(0, filtered.length - RECENT_WINDOW);

        const pastMessages = filtered.slice(0, splitIndex);
        const recentMessages = filtered.slice(splitIndex);


        // 1. Consolidate Past Summaries
        let historicalContext = '';
        let actHeaderInserted = false;
        const actHeader = this.lang.locale().actHeader.trim();

        if (!useFullContext && pastMessages.length > 0) {
            // When compression is active, prepend ACT header BEFORE historical context
            historicalContext = actHeader + '\n';
            actHeaderInserted = true;

            pastMessages.forEach((m) => {
                if (m.role === 'model') {
                    const stateUpdates: string[] = this.getDetailFields(m);

                    if (stateUpdates.length > 0) {
                        const headerMatch = m.content.match(/\[\s*[^\]]*\d+年\s*\d+月\d+日[^\]]*\]/);
                        const baseHeader = headerMatch ? headerMatch[0] : '';

                        // Extract all [T XXX] time markers across the entire message content
                        const tMatches = [...m.content.matchAll(/\[T\s*([^\]]+)\]/g)];
                        let timeHeader = '';
                        if (tMatches.length > 1) {
                            // If multiple markers exist (e.g., spans across time), format as range
                            const start = tMatches[0][1].trim();
                            const end = tMatches[tMatches.length - 1][1].trim();
                            timeHeader = `[T ${start}~T ${end}]`;
                        } else if (tMatches.length === 1) {
                            // Just use the single marker found
                            timeHeader = tMatches[0][0];
                        }

                        const finalHeader = [baseHeader, timeHeader].filter(h => !!h).join(' ');
                        historicalContext += (finalHeader ? `${finalHeader} ` : '') + `---\n${stateUpdates.join('\n')}\n---\n`;
                    }
                }
            });
        }

        // 2. Build Recent History (Standard Format)
        const llmHistory: LLMContent[] = recentMessages.map((m, idx) => {
            const parts: LLMPart[] = [];

            if (m.parts && m.parts.length > 0) {
                m.parts.forEach(p => {
                    // Skip internal thought parts ONLY if they don't carry a required signature
                    if ((p as ExtendedPart).thought && !(p as ExtendedPart).thoughtSignature) return;
                    // Skip existing file/context parts matches (to avoid duplication if re-injecting)
                    if (p.fileData && p.fileData.fileUri === this.state.kbFileUri()) return;
                    if (p.text && p.text.startsWith(LLM_MARKERS.FILE_CONTENT_SEPARATOR)) return;
                    if (p.text && p.text.startsWith(LLM_MARKERS.SYSTEM_RULE_SEPARATOR)) return;

                    if (p.text) {
                        parts.push({ ...p, text: this.stripSavePoints(p.text) });
                    } else {
                        parts.push({ ...p });
                    }
                });
            }
            // Fallback if parts are empty (e.g. legacy or stripped)
            if (parts.length === 0 && m.content) {
                parts.push({ text: this.stripSavePoints(m.content) });
            }

            // For model messages: Append Turn Update (summary, inventory_log, quest_log)
            // This ensures LLM sees previous state changes and doesn't regenerate them
            if (m.role === 'model') {
                const turnUpdateParts: string[] = this.getDetailFields(m);

                if (turnUpdateParts.length > 0) {
                    // Find last text part (non-thought) and append
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

            // If this is the 'last scene' model message (within recent), append ACT header AFTER its content
            if (!actHeaderInserted && this.isLastSceneMessage(recentMessages[idx])) {
                // Find last text part and append the header
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
                actHeaderInserted = true;
            }

            return { role: m.role, parts };
        });

        // 3. Inject Historical Context into the First Message
        const contextBlock = historicalContext.trim();

        if (contextBlock) {

            if (llmHistory.length > 0) {
                const firstMsg = llmHistory[0];

                const msgParts = firstMsg.parts || [];
                let targetPart = msgParts.find(p => p.text !== undefined);
                if (!targetPart) {
                    targetPart = { text: '' };
                    msgParts.unshift(targetPart);
                }

                // Prepend context
                targetPart.text = contextBlock + (targetPart.text || '');
                firstMsg.parts = msgParts;
            } else {
                // If no recent messages (rare?), create one
                llmHistory.push({ role: 'user', parts: [{ text: contextBlock }] });
            }
            console.log(`[ContextBuilder] Consolidated ${pastMessages.length} past messages into a single context block.`);
        }

        // 4. DYNAMIC CONTEXT INJECTION (Files/KB)
        // If NOT using Cache, we must manually inject the context (File or Text) into the first message
        // This is separate from Historical Context.
        if (!this.state.kbCacheName()) {
            let contextParts: LLMPart[] = [];

            if (this.state.kbFileUri()) {
                contextParts.push({
                    fileData: {
                        fileUri: this.state.kbFileUri()!,
                        mimeType: 'text/plain'
                    }
                });
            } else if (this.state.loadedFiles().size > 0) {
                contextParts = this.kb.buildKnowledgeBaseParts(this.state.loadedFiles());
            }

            if (contextParts.length > 0) {
                if (llmHistory.length > 0) {
                    const firstMsg = llmHistory[0];
                    if (firstMsg.role === 'user') {
                        const msgParts = firstMsg.parts || [];
                        firstMsg.parts = [...contextParts, ...msgParts];
                    } else {
                        llmHistory.unshift({ role: 'user', parts: contextParts });
                    }
                } else {
                    llmHistory.push({ role: 'user', parts: contextParts });
                }
                console.log('[ContextBuilder] Dynamically injected KB context into history.');
            }
        }

        return llmHistory;
    }

    /**
     * Constructs a filtered chat history for save auditing.
     * Removes system and save intent messages.
     * Uses the standard context building logic (in save mode).
     * @returns Array of Content objects.
     */
    public getAuditHistory(): LLMContent[] {
        return this.getLLMHistory(true, (m: ChatMessage) => {
            // Keep tool responses even if refOnly
            if (m.isRefOnly && !m.parts?.some(p => p.functionResponse)) return false;
            // Exclude system and save intents for auditing
            if (m.intent === 'system' || m.intent === 'save') return false;
            return true;
        });
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
}
