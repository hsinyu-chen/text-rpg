import { Injectable, inject } from '@angular/core';
import { ContentParserService } from './content-parser.service';
import { PostProcessorService, PostProcessFields } from './post-processor.service';
import { ExtendedPart, ThoughtPart } from '../models/types';
import { LLMStreamChunk, LLMUsageMetadata } from '@hcs/llm-core';
import { ChatMessage } from '../models/types';
import { I18nService } from '../i18n';
import type { SingleCallResponse, StructuredAnalysis } from '../constants/engine-protocol-structured';
import type { NarratorOutput } from '../constants/engine-protocol-two-call';
import { assembleStoryWithSceneHeader, formatStructuredAnalysis } from './turn-engines/format-structured-analysis';
import type { SceneSnapshot } from '../constants/engine-protocol-structured';
import { mergeUsage } from './llm-usage-merge';

export interface StreamProcessResult {
    finalAnalysis: string;
    finalStory: string;
    finalSummary: string;
    finalCharacterLog: string[];
    finalInventoryLog: string[];
    finalQuestLog: string[];
    finalWorldLog: string[];
    correction: string;
    turnUsage: LLMUsageMetadata;
    capturedFCs: ExtendedPart[];
    capturedThoughtSignature?: string;
    finalThought: string;
    finalFinishReason?: string;
    /**
     * Tokens occupying the KV cache after the final LLM call of this turn.
     * In two-call mode `turnUsage.prompt + turnUsage.candidates` sums BOTH
     * calls — wrong for the post-turn cache view since only the narrator
     * call's tokens remain. Single-call leaves this undefined; the sidebar
     * falls back to `prompt + candidates` (which is correct there).
     */
    contextTokens?: number;
}

@Injectable({
    providedIn: 'root'
})
export class StreamProcessorService {
    private parser = inject(ContentParserService);
    private postProcessor = inject(PostProcessorService);
    private i18n = inject(I18nService);

    /** Streaming-phase log mapper: parse + apply safe replacements per item, so the live UI sees post-processed text. */
    private mapLogStream(log: string[] | undefined): string[] | undefined {
        if (!Array.isArray(log)) return undefined;
        return log.map(item => this.postProcessor.applySafeReplacements(this.parser.processModelField(item)));
    }

    /** Final-phase log mapper: parse only — postProcessor.process is run on the full struct after parsing. */
    private mapLogFinal(log: string[] | undefined): string[] {
        if (!Array.isArray(log)) return [];
        return log.map(item => this.parser.processModelField(item));
    }

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
        let turnUsage: LLMUsageMetadata = { prompt: 0, candidates: 0, cached: 0 };
        const capturedFCs: ExtendedPart[] = [];
        let capturedThoughtSignature: string | undefined;
        let finalFinishReason: string | undefined;
        let cotClosed = false;

        // Initialize empty model message
        updateCallback(prev => [...prev, { id: modelMsgId, role: 'model', content: '', thought: '', isThinking: true, cotOpen: true }]);

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
                        const last = arr[arr.length - 1];
                        if (last?.role === 'model') {
                            arr[arr.length - 1] = { ...last, thought: currentThought };
                        }
                        return arr;
                    });
                } else {
                    currentJSONAccumulator += part.text;
                    if (!cotClosed) {
                        cotClosed = true;
                        updateCallback(prev => {
                            const arr = [...prev];
                            const last = arr[arr.length - 1];
                            if (last?.role === 'model' && last.id === modelMsgId) {
                                arr[arr.length - 1] = { ...last, cotOpen: false };
                            }
                            return arr;
                        });
                    }

                    // Streaming Parsers for all fields
                    try {
                        const partial = this.parser.bestEffortJsonParser(currentJSONAccumulator) as Partial<SingleCallResponse>;

                        // Real-time Update
                        updateCallback(prev => {
                            const arr = [...prev];
                            const last = arr[arr.length - 1];
                            if (last?.role === 'model') {
                                const next = { ...last, isThinking: true };

                                let snap: Partial<SceneSnapshot> | null = null;
                                if (partial.analysis && typeof partial.analysis === 'object') {
                                    const analysisObj = partial.analysis as Partial<StructuredAnalysis>;
                                    snap = analysisObj.scene_snapshot ?? null;
                                    currentAnalysisPreview = formatStructuredAnalysis(analysisObj, outputLanguage);
                                    if (currentAnalysisPreview) {
                                        next.analysis = this.postProcessor.applySafeReplacements(currentAnalysisPreview);
                                    }
                                }

                                if (partial.story) {
                                    currentStoryPreview = this.parser.processModelField(partial.story);
                                    const withHeader = assembleStoryWithSceneHeader(currentStoryPreview, snap);
                                    next.content = this.postProcessor.applySafeReplacements(withHeader);
                                }
                                if (partial.summary) {
                                    next.summary = this.postProcessor.applySafeReplacements(this.parser.processModelField(partial.summary));
                                }
                                const character_log = this.mapLogStream(partial.character_log);
                                const inventory_log = this.mapLogStream(partial.inventory_log);
                                const quest_log = this.mapLogStream(partial.quest_log);
                                const world_log = this.mapLogStream(partial.world_log);
                                if (character_log) next.character_log = character_log;
                                if (inventory_log) next.inventory_log = inventory_log;
                                if (quest_log) next.quest_log = quest_log;
                                if (world_log) next.world_log = world_log;

                                arr[arr.length - 1] = next;
                            }
                            return arr;
                        });
                    } catch { /* ignore parsing errors during stream */ }
                }
            }

            if (chunk.usageMetadata) {
                turnUsage = mergeUsage(turnUsage, chunk.usageMetadata);

                if (chunk.usageMetadata.promptProgress !== undefined) {
                    updateCallback(prev => {
                        const arr = [...prev];
                        const last = arr[arr.length - 1];
                        if (last?.role === 'model') {
                            arr[arr.length - 1] = {
                                ...last,
                                progress: chunk.usageMetadata!.promptProgress,
                                usage: { ...turnUsage }
                            };
                        }
                        return arr;
                    });
                }
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
        let correction = '';

        try {
            const parsed = this.parser.bestEffortJsonParser(currentJSONAccumulator) as Partial<SingleCallResponse>;

            let finalSnap: Partial<SceneSnapshot> | null = null;
            if (parsed.analysis && typeof parsed.analysis === 'object') {
                const analysisObj = parsed.analysis as Partial<StructuredAnalysis>;
                finalSnap = analysisObj.scene_snapshot ?? null;
                finalAnalysis = formatStructuredAnalysis(analysisObj, outputLanguage);
            }

            if (parsed.story) {
                finalStory = assembleStoryWithSceneHeader(this.parser.processModelField(parsed.story), finalSnap);
            }
            if (parsed.summary) finalSummary = this.parser.processModelField(parsed.summary);

            finalCharacterLog = this.mapLogFinal(parsed.character_log);
            finalInventoryLog = this.mapLogFinal(parsed.inventory_log);
            finalQuestLog = this.mapLogFinal(parsed.quest_log);
            finalWorldLog = this.mapLogFinal(parsed.world_log);

            if (typeof parsed.correction === 'string' && parsed.correction.trim()) {
                correction = this.parser.processModelField(parsed.correction).trim();
            }
        } catch (jsonErr) {
            console.error('[StreamProcessor] JSON Parse Failed:', jsonErr);
            finalAnalysis = '';
            finalStory = currentStoryPreview || this.i18n.translate('ui.FORMAT_ERROR');
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
            correction,
            turnUsage,
            capturedFCs,
            capturedThoughtSignature,
            finalThought: currentThought,
            finalFinishReason
        };
    }

    /**
     * Two-call narrator stream variant. Parses the flat narrator schema
     * (`{story, summary, *_log, interrupted_acknowledged}` — no analysis,
     * no response wrapper, no correction) and updates the existing model
     * message in-place. The caller (TwoCallTurnEngine) is responsible for
     * having already pushed the empty model message during the resolver
     * phase, so this method does NOT push a new one.
     *
     * Returns the same StreamProcessResult shape as {@link processStream}
     * for orchestrator symmetry; `finalAnalysis` and `correction` are
     * always empty strings on this path.
     */
    async processNarratorStream(
        stream: AsyncIterable<LLMStreamChunk>,
        modelMsgId: string,
        outputLanguage: string,
        updateCallback: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void,
        seedThought = '',
        sceneSnapshot: Partial<SceneSnapshot> | null = null
    ): Promise<StreamProcessResult> {
        let currentJSONAccumulator = '';
        let currentStoryPreview = '';
        let currentThought = seedThought;
        let turnUsage: LLMUsageMetadata = { prompt: 0, candidates: 0, cached: 0 };
        const capturedFCs: ExtendedPart[] = [];
        let capturedThoughtSignature: string | undefined;
        let finalFinishReason: string | undefined;
        let cotClosed = false;

        const updateLastModel = (patch: (prev: ChatMessage) => ChatMessage) => {
            updateCallback(prev => {
                const arr = [...prev];
                const last = arr[arr.length - 1];
                if (last?.role === 'model' && last.id === modelMsgId) {
                    arr[arr.length - 1] = patch(last);
                }
                return arr;
            });
        };

        for await (const chunk of stream) {
            const part: LLMStreamChunk = chunk;

            if (part.thoughtSignature) {
                capturedThoughtSignature = part.thoughtSignature;
            }

            if (part.finishReason) {
                finalFinishReason = part.finishReason;
            }

            if (part.functionCall) {
                capturedFCs.push(part);
            }

            if (part.text) {
                if ((part as ThoughtPart).thought) {
                    currentThought += part.text;
                    updateLastModel(last => ({ ...last, thought: currentThought }));
                } else {
                    currentJSONAccumulator += part.text;
                    if (!cotClosed) {
                        cotClosed = true;
                        updateLastModel(last => ({ ...last, cotOpen: false }));
                    }
                    try {
                        const partial = this.parser.bestEffortJsonParser(currentJSONAccumulator) as Partial<NarratorOutput>;
                        updateLastModel(last => {
                            const next: ChatMessage = { ...last, isThinking: true };
                            if (partial.story) {
                                currentStoryPreview = this.parser.processModelField(partial.story);
                                const withHeader = assembleStoryWithSceneHeader(currentStoryPreview, sceneSnapshot);
                                next.content = this.postProcessor.applySafeReplacements(withHeader);
                            }
                            if (partial.summary) {
                                next.summary = this.postProcessor.applySafeReplacements(this.parser.processModelField(partial.summary));
                            }
                            const character_log = this.mapLogStream(partial.character_log);
                            const inventory_log = this.mapLogStream(partial.inventory_log);
                            const quest_log = this.mapLogStream(partial.quest_log);
                            const world_log = this.mapLogStream(partial.world_log);
                            if (character_log) next.character_log = character_log;
                            if (inventory_log) next.inventory_log = inventory_log;
                            if (quest_log) next.quest_log = quest_log;
                            if (world_log) next.world_log = world_log;
                            return next;
                        });
                    } catch { /* ignore parsing errors during stream */ }
                }
            }

            if (chunk.usageMetadata) {
                turnUsage = mergeUsage(turnUsage, chunk.usageMetadata);
                if (chunk.usageMetadata.promptProgress !== undefined) {
                    updateLastModel(last => ({ ...last, progress: chunk.usageMetadata!.promptProgress, usage: { ...turnUsage } }));
                }
            }
        }

        let finalStory = currentStoryPreview;
        let finalSummary = '';
        let finalCharacterLog: string[] = [];
        let finalInventoryLog: string[] = [];
        let finalQuestLog: string[] = [];
        let finalWorldLog: string[] = [];

        try {
            const parsed = this.parser.bestEffortJsonParser(currentJSONAccumulator) as Partial<NarratorOutput>;
            if (parsed.story) {
                finalStory = assembleStoryWithSceneHeader(this.parser.processModelField(parsed.story), sceneSnapshot);
            }
            if (parsed.summary) finalSummary = this.parser.processModelField(parsed.summary);
            finalCharacterLog = this.mapLogFinal(parsed.character_log);
            finalInventoryLog = this.mapLogFinal(parsed.inventory_log);
            finalQuestLog = this.mapLogFinal(parsed.quest_log);
            finalWorldLog = this.mapLogFinal(parsed.world_log);
        } catch (jsonErr) {
            console.error('[StreamProcessor] Narrator JSON Parse Failed:', jsonErr);
            finalStory = currentStoryPreview || this.i18n.translate('ui.FORMAT_ERROR');
        }

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
            finalAnalysis: '',
            finalStory: processed.story,
            finalSummary: processed.summary,
            finalCharacterLog: processed.character_log,
            finalInventoryLog: processed.inventory_log,
            finalQuestLog: processed.quest_log,
            finalWorldLog: processed.world_log,
            correction: '',
            turnUsage,
            capturedFCs,
            capturedThoughtSignature,
            finalThought: currentThought,
            finalFinishReason
        };
    }
}
