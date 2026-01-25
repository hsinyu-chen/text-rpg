import { Injectable, inject } from '@angular/core';
import { ContentParserService } from './content-parser.service';
import { PostProcessorService, PostProcessFields } from './post-processor.service';
import { ExtendedPart, ThoughtPart, EngineResponseNested } from '../models/types';
import { LLMStreamChunk } from './llm-provider';
import { ChatMessage } from '../models/types';
import { getUIStrings } from '../constants/engine-protocol';

export interface StreamProcessResult {
    finalAnalysis: string;
    finalStory: string;
    finalSummary: string;
    finalCharacterLog: string[];
    finalInventoryLog: string[];
    finalQuestLog: string[];
    finalWorldLog: string[];
    isCorrection: boolean;
    turnUsage: { prompt: number, candidates: number, cached: number };
    capturedFCs: ExtendedPart[];
    capturedThoughtSignature?: string;
    finalThought: string;
    finalFinishReason?: string;
}

@Injectable({
    providedIn: 'root'
})
export class StreamProcessorService {
    private parser = inject(ContentParserService);
    private postProcessor = inject(PostProcessorService);

    /**
     * Processes an LLM stream, updating the UI in real-time and returning the finalized content.
     * @param stream The async generator from the provider.
     * @param modelMsgId The ID of the model message being generated.
     * @param outputLanguage The current output language for UI strings.
     * @param updateCallback Callback to update the chat messages in the UI.
     * @returns The finalized content and usage stats.
     */
    async processStream(
        stream: AsyncIterable<LLMStreamChunk>,
        modelMsgId: string,
        outputLanguage: string,
        updateCallback: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void
    ): Promise<StreamProcessResult> {
        let currentJSONAccumulator = '';
        let currentStoryPreview = '';
        let currentAnalysisPreview = '';
        let currentThought = '';
        let turnUsage = { prompt: 0, candidates: 0, cached: 0 };
        const capturedFCs: ExtendedPart[] = [];
        let capturedThoughtSignature: string | undefined;
        let finalFinishReason: string | undefined;

        // Initialize empty model message
        updateCallback(prev => [...prev, { id: modelMsgId, role: 'model', content: '', thought: '', isThinking: true }]);

        for await (const chunk of stream) {
            const part: LLMStreamChunk = chunk;
            const extPart = part; // Alias

            if (extPart.thoughtSignature) {
                capturedThoughtSignature = extPart.thoughtSignature;
            }

            if (extPart.finishReason) {
                finalFinishReason = extPart.finishReason;
            }

            if (part.functionCall) {
                capturedFCs.push(extPart);
            }

            if (part.text) {
                if ((part as ThoughtPart).thought) {
                    currentThought += part.text;
                    updateCallback(prev => {
                        const arr = [...prev];
                        if (arr[arr.length - 1]?.role === 'model') {
                            arr[arr.length - 1].thought = currentThought;
                        }
                        return arr;
                    });
                } else {
                    currentJSONAccumulator += part.text;

                    // Streaming Parsers for all fields
                    try {
                        const partial = this.parser.bestEffortJsonParser(currentJSONAccumulator) as Partial<EngineResponseNested>;

                        // Real-time Update
                        updateCallback(prev => {
                            const arr = [...prev];
                            const last = arr[arr.length - 1];
                            if (last?.role === 'model') {
                                const next = { ...last, isThinking: true };

                                // Update Fields if they exist in partial
                                if (partial.analysis) {
                                    currentAnalysisPreview = this.parser.processModelField(partial.analysis);
                                    next.analysis = this.postProcessor.applySafeReplacements(currentAnalysisPreview);
                                }

                                if (partial.response) {
                                    if (partial.response.story) {
                                        currentStoryPreview = this.parser.processModelField(partial.response.story);
                                        next.content = this.postProcessor.applySafeReplacements(currentStoryPreview);
                                    }
                                    if (partial.response.summary) {
                                        next.summary = this.postProcessor.applySafeReplacements(this.parser.processModelField(partial.response.summary));
                                    }
                                    if (Array.isArray(partial.response.character_log)) {
                                        next.character_log = partial.response.character_log.map(c => this.postProcessor.applySafeReplacements(this.parser.processModelField(c)));
                                    }
                                    if (Array.isArray(partial.response.inventory_log)) {
                                        next.inventory_log = partial.response.inventory_log.map(i => this.postProcessor.applySafeReplacements(this.parser.processModelField(i)));
                                    }
                                    if (Array.isArray(partial.response.quest_log)) {
                                        next.quest_log = partial.response.quest_log.map(q => this.postProcessor.applySafeReplacements(this.parser.processModelField(q)));
                                    }
                                    if (Array.isArray(partial.response.world_log)) {
                                        next.world_log = partial.response.world_log.map(w => this.postProcessor.applySafeReplacements(this.parser.processModelField(w)));
                                    }
                                }

                                arr[arr.length - 1] = next;
                            }
                            return arr;
                        });
                    } catch { /* ignore parsing errors during stream */ }
                }
            }

            if (chunk.usageMetadata) {
                // "Sticky" update: Only update if non-zero to avoid losing data in final chunks
                turnUsage = {
                    prompt: chunk.usageMetadata.promptTokens || turnUsage.prompt,
                    candidates: chunk.usageMetadata.completionTokens || turnUsage.candidates,
                    cached: chunk.usageMetadata.cachedTokens || turnUsage.cached
                };
            }
        }

        // Finalize
        let finalAnalysis = '';
        let finalStory = currentStoryPreview;
        let finalSummary = '';
        let finalCharacterLog: string[] = [];
        let finalInventoryLog: string[] = [];
        let finalQuestLog: string[] = [];
        let finalWorldLog: string[] = [];
        let isCorrection = false;

        try {
            const parsed = this.parser.bestEffortJsonParser(currentJSONAccumulator) as Partial<EngineResponseNested>;

            if (parsed.analysis) finalAnalysis = this.parser.processModelField(parsed.analysis);

            if (parsed.response) {
                if (parsed.response.story) finalStory = this.parser.processModelField(parsed.response.story);
                if (parsed.response.summary) finalSummary = this.parser.processModelField(parsed.response.summary);

                if (Array.isArray(parsed.response.character_log)) {
                    finalCharacterLog = parsed.response.character_log.map(c => this.parser.processModelField(c));
                }
                if (Array.isArray(parsed.response.inventory_log)) {
                    finalInventoryLog = parsed.response.inventory_log.map(i => this.parser.processModelField(i));
                }
                if (Array.isArray(parsed.response.quest_log)) {
                    finalQuestLog = parsed.response.quest_log.map(q => this.parser.processModelField(q));
                }
                if (Array.isArray(parsed.response.world_log)) {
                    finalWorldLog = parsed.response.world_log.map(w => this.parser.processModelField(w));
                }

                if (parsed.response.isCorrection) isCorrection = true;
            }
        } catch (jsonErr) {
            console.error('[StreamProcessor] JSON Parse Failed:', jsonErr);
            finalAnalysis = '';
            const ui = getUIStrings(outputLanguage);
            finalStory = currentStoryPreview || ui.FORMAT_ERROR;
        }

        // Apply user post-processing
        const postProcessFields: PostProcessFields = {
            story: finalStory,
            summary: finalSummary,
            character_log: finalCharacterLog,
            inventory_log: finalInventoryLog,
            quest_log: finalQuestLog,
            world_log: finalWorldLog
        };
        const processed = this.postProcessor.process(postProcessFields);

        return {
            finalAnalysis,
            finalStory: processed.story,
            finalSummary: processed.summary,
            finalCharacterLog: processed.character_log,
            finalInventoryLog: processed.inventory_log,
            finalQuestLog: processed.quest_log,
            finalWorldLog: processed.world_log,
            isCorrection,
            turnUsage,
            capturedFCs,
            capturedThoughtSignature,
            finalThought: currentThought,
            finalFinishReason
        };
    }
}
