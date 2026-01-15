import { Injectable, inject } from '@angular/core';
import { ContentParserService } from './content-parser.service';
import { ExtendedPart, ThoughtPart, EngineResponseNested } from '../models/types';
import { LLMStreamChunk } from './llm-provider';
import { ChatMessage } from '../models/types';
import { getUIStrings } from '../constants/engine-protocol';

export interface StreamProcessResult {
    finalAnalysis: string;
    finalStory: string;
    finalSummary: string;
    finalInventoryLog: string[];
    finalQuestLog: string[];
    finalWorldLog: string[];
    isCorrection: boolean;
    turnUsage: { prompt: number, candidates: number, cached: number };
    capturedFCs: ExtendedPart[];
    capturedThoughtSignature?: string;
    finalThought: string;
}

@Injectable({
    providedIn: 'root'
})
export class StreamProcessorService {
    private parser = inject(ContentParserService);

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

        // Initialize empty model message
        updateCallback(prev => [...prev, { id: modelMsgId, role: 'model', content: '', thought: '', isThinking: true }]);

        for await (const chunk of stream) {
            const part: LLMStreamChunk = chunk;
            const extPart = part; // Alias

            if (extPart.thoughtSignature) {
                capturedThoughtSignature = extPart.thoughtSignature;
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

                    // Streaming Parsers
                    const analysisMatch = /"analysis"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(currentJSONAccumulator);
                    if (analysisMatch && analysisMatch[1]) {
                        try {
                            currentAnalysisPreview = this.parser.processModelField(analysisMatch[1]);
                        } catch { /* ignore */ }
                    }

                    const storyMatch = /"story"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(currentJSONAccumulator);
                    if (storyMatch && storyMatch[1]) {
                        try {
                            currentStoryPreview = this.parser.processModelField(storyMatch[1]);
                        } catch { /* ignore */ }
                    }
                }
            }

            // Real-time Update
            updateCallback(prev => {
                const arr = [...prev];
                const last = arr[arr.length - 1];
                if (last?.role === 'model') {
                    arr[arr.length - 1] = {
                        ...last,
                        content: currentStoryPreview,
                        analysis: currentAnalysisPreview,
                        isThinking: true
                    };
                }
                return arr;
            });

            if (chunk.usageMetadata) {
                turnUsage = {
                    prompt: chunk.usageMetadata.promptTokens || 0,
                    candidates: chunk.usageMetadata.completionTokens || 0,
                    cached: chunk.usageMetadata.cachedTokens || 0
                };
            }
        }

        // Finalize
        let finalAnalysis = '';
        let finalStory = currentStoryPreview;
        let finalSummary = '';
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

        return {
            finalAnalysis,
            finalStory,
            finalSummary,
            finalInventoryLog,
            finalQuestLog,
            finalWorldLog,
            isCorrection,
            turnUsage,
            capturedFCs,
            capturedThoughtSignature,
            finalThought: currentThought
        };
    }
}
