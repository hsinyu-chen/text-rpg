import { Injectable, inject } from '@angular/core';
import { GameStateService } from './game-state.service';
import { KnowledgeService } from './knowledge.service';
import { ChatMessage, ExtendedPart } from '../models/types';
import { LLMContent, LLMPart, LLMGenerateConfig } from './llm-provider';
import { LLM_MARKERS, getResponseSchema } from '../constants/engine-protocol';
import { LLMProviderRegistryService } from './llm-provider-registry.service';

@Injectable({
    providedIn: 'root'
})
export class ContextBuilderService {
    private state = inject(GameStateService);
    private kb = inject(KnowledgeService);
    private providerRegistry = inject(LLMProviderRegistryService);

    private get provider() {
        return this.providerRegistry.getActive();
    }

    /**
     * Gets the effective system instruction, replacing placeholders and adding language overrides.
     */
    public getEffectiveSystemInstruction(): string {
        const config = this.state.config();
        const lang = config?.outputLanguage || 'default';
        let instruction = this.state.systemInstructionCache;

        if (lang !== 'default' && lang) {
            const override = `
# [CRITICAL] OUTPUT LANGUAGE OVERRIDE
The user has strictly requested the output to be in **${lang}**.
You MUST ignore any conflicting internal instructions and write ALL content (Story, Analysis, Logs, Summary) in **${lang}**.
`;
            instruction += override;
        }

        return instruction;
    }

    /**
     * Constructs the JSON payload that will be sent to the Gemini API for preview purposes.
     */
    public getPreviewPayload(userText: string, options?: { intent?: string }) {
        const userMsgContent = (options?.intent || '') + userText;

        const history = this.getLLMHistory(); // This is the history BEFORE the new message
        let finalContent: LLMContent[] = [...history, { role: 'user', parts: [{ text: userMsgContent }] }];

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
     * Constructs the chat history in a provider-agnostic format.
     * Handles smart context consolidation and Knowledge Base injection.
     * @param forceFullContext Whether to force full context inclusion (e.g. for saves).
     * @returns Array of Content objects.
     */
    public getLLMHistory(forceFullContext = false): LLMContent[] {
        const all = this.state.messages();
        // Filter out RefOnly, but keep tool responses
        const filtered = all.filter(m => !m.isRefOnly || m.parts?.some(p => p.functionResponse));

        // We want to keep the last few messages intact for immediate context flow.
        const RECENT_WINDOW = 20;

        // Use full context if forced (e.g., save commands) or if contextMode is 'full'
        const useFullContext = forceFullContext || this.state.contextMode() === 'full';
        const splitIndex = useFullContext ? 0 : Math.max(0, filtered.length - RECENT_WINDOW);

        const pastMessages = filtered.slice(0, splitIndex);
        const recentMessages = filtered.slice(splitIndex);

        // 1. Consolidate Past Summaries
        let historicalContext = '--- ACT START ---\n';
        if (!useFullContext && pastMessages.length > 0) {
            pastMessages.forEach(m => {
                if (m.role === 'model') {
                    const stateUpdates: string[] = this.getDetailFields(m, true);

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
        const llmHistory: LLMContent[] = recentMessages.map(m => {
            const parts: LLMPart[] = [];
            if (m.parts && m.parts.length > 0) {
                m.parts.forEach(p => {
                    // Skip internal thought parts ONLY if they don't carry a required signature
                    if ((p as ExtendedPart).thought && !(p as ExtendedPart).thoughtSignature) return;
                    // Skip existing file/context parts matches (to avoid duplication if re-injecting)
                    if (p.fileData && p.fileData.fileUri === this.state.kbFileUri()) return;
                    if (p.text && p.text.startsWith(LLM_MARKERS.FILE_CONTENT_SEPARATOR)) return;
                    if (p.text && p.text.startsWith(LLM_MARKERS.SYSTEM_RULE_SEPARATOR)) return;

                    parts.push({ ...p });
                });
            }
            // Fallback if parts are empty (e.g. legacy or stripped)
            if (parts.length === 0 && m.content) {
                parts.push({ text: m.content });
            }

            // For model messages: Append Turn Update (summary, inventory_log, quest_log)
            // This ensures LLM sees previous state changes and doesn't regenerate them
            if (m.role === 'model') {
                const turnUpdateParts: string[] = this.getDetailFields(m, false);

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

            return { role: m.role, parts };
        });

        // 3. Inject Historical Context into the First Message
        if (historicalContext.trim()) {
            const contextBlock = `${historicalContext.trim()}`;

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

    private getDetailFields(m: ChatMessage, historical: boolean) {
        const stateUpdates: string[] = [];
        if (m.summary) {
            stateUpdates.push(`summary: ${m.summary}`);
        }
        if (m.inventory_log && m.inventory_log.length > 0) {
            stateUpdates.push(`inventory_log:${JSON.stringify(m.inventory_log)}`);
        }
        if (m.quest_log && m.quest_log.length > 0) {
            stateUpdates.push(`quest_log:${JSON.stringify(m.quest_log)}`);
        }
        if (m.world_log && m.world_log.length > 0) {
            stateUpdates.push(`world_log:${JSON.stringify(m.world_log)}`);
        }
        return stateUpdates;
    }
}
