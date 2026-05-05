import { Injectable, inject } from '@angular/core';
import { LLMContent, LLMProvider, LLMProviderConfig, LLMUsageMetadata } from '@hcs/llm-core';
import { ContentParserService } from '../content-parser.service';
import { StreamProcessorService, StreamProcessResult } from '../stream-processor.service';
import { ChatMessage } from '@app/core/models/types';
import { getResolverSchema, getNarratorSchema } from '@app/core/constants/engine-protocol-two-call';
import {
    AnalysisStep,
    IdealStrength,
    ResolverResponse,
    SceneSnapshot,
    StructuredAnalysis,
    interruptedAtStep,
    isInterrupted
} from '@app/core/constants/engine-protocol-structured';
import { formatStructuredAnalysis } from './format-structured-analysis';
import { mergeUsage } from '../llm-usage-merge';

export interface ResolverRunResult {
    resolverOutput: ResolverResponse;
    rawJson: string;
    /** Concatenated `thought` chunks from the resolver call (CoT). Empty when the model emits no thought stream. */
    thought: string;
    usage: LLMUsageMetadata;
    finishReason?: string;
}

interface OrchestratorRuntime {
    provider: LLMProvider;
    providerConfig: LLMProviderConfig;
    cachedContentName?: string;
    systemInstruction: string;
}

/**
 * Drives the two LLM calls of two-call mode. {@link TwoCallTurnEngine} coordinates
 * context building + truncation around these primitives.
 *
 * `runResolver` does NOT touch the chat message — the resolver phase is an
 * internal computation. The orchestrator parses the streamed JSON into a
 * {@link ResolverResponse} and exposes the raw text so a presenter can show
 * the trace separately.
 *
 * `runNarrator` updates the existing model message in place via
 * {@link StreamProcessorService.processNarratorStream}; the caller is expected
 * to have already pushed the empty model message before the resolver phase began.
 */
@Injectable({ providedIn: 'root' })
export class TwoCallOrchestratorService {
    private parser = inject(ContentParserService);
    private streamProcessor = inject(StreamProcessorService);

    async runResolver(input: OrchestratorRuntime & {
        history: LLMContent[];
        outputLanguage: string;
        intent: string;
        signal: AbortSignal;
        modelMsgId?: string;
        updateMessages?: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
    }): Promise<ResolverRunResult> {
        const stream = input.provider.generateContentStream(
            input.providerConfig,
            input.history,
            input.systemInstruction,
            {
                cachedContentName: input.cachedContentName,
                responseSchema: getResolverSchema(input.outputLanguage),
                responseMimeType: 'application/json',
                intent: input.intent,
                signal: input.signal
            }
        );

        let accumulator = '';
        let thoughtAccumulator = '';
        let usage: LLMUsageMetadata = { prompt: 0, candidates: 0, cached: 0 };
        let finishReason: string | undefined;
        let lastTraceText = '';
        let cotClosed = false;

        const patchLastModel = (patch: (prev: ChatMessage) => ChatMessage) => {
            if (!input.updateMessages || !input.modelMsgId) return;
            input.updateMessages(prev => {
                const arr = [...prev];
                const last = arr[arr.length - 1];
                if (last?.role === 'model' && last.id === input.modelMsgId) {
                    arr[arr.length - 1] = patch(last);
                }
                return arr;
            });
        };

        for await (const chunk of stream) {
            if (chunk.finishReason) finishReason = chunk.finishReason;
            if (chunk.text) {
                if (chunk.thought) {
                    thoughtAccumulator += chunk.text;
                    patchLastModel(last => ({ ...last, thought: thoughtAccumulator, isThinking: true }));
                } else {
                    accumulator += chunk.text;
                    if (!cotClosed) {
                        cotClosed = true;
                        patchLastModel(last => ({ ...last, cotOpen: false }));
                    }
                    try {
                        const partial = this.parser.bestEffortJsonParser(accumulator) as Partial<ResolverResponse>;
                        const trace = formatStructuredAnalysis(partial.analysis ?? null);
                        if (trace && trace !== lastTraceText) {
                            lastTraceText = trace;
                            patchLastModel(last => ({ ...last, analysis: trace, isThinking: true }));
                        }
                    } catch { /* parse errors during stream are expected */ }
                }
            }
            if (chunk.usageMetadata) {
                usage = mergeUsage(usage, chunk.usageMetadata);
                if (chunk.usageMetadata.promptProgress !== undefined) {
                    patchLastModel(last => ({
                        ...last,
                        progress: chunk.usageMetadata!.promptProgress,
                        usage: { ...usage }
                    }));
                }
            }
        }

        let parsed: Partial<ResolverResponse> | null = null;
        try {
            parsed = this.parser.bestEffortJsonParser(accumulator) as Partial<ResolverResponse>;
        } catch (err) {
            // bestEffortJsonParser swallows its own parse errors and returns {},
            // so this catch is defensive — guards against any future change to
            // its contract or downstream cast failures.
            console.error('[TwoCallOrchestrator] Resolver JSON parse failed:', err);
        }
        const resolverOutput = this.normalizeResolver(parsed ?? {});
        return { resolverOutput, rawJson: accumulator, thought: thoughtAccumulator, usage, finishReason };
    }

    async runNarrator(input: OrchestratorRuntime & {
        history: LLMContent[];
        outputLanguage: string;
        intent: string;
        modelMsgId: string;
        signal: AbortSignal;
        updateMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
        /** CoT from the resolver call to prepend in the same `thought` field, so a single panel shows both phases. */
        seedThought?: string;
        /** Truncated analysis from the resolver — narrator stream prepends its scene header to story. */
        sceneSnapshot?: SceneSnapshot | null;
    }): Promise<StreamProcessResult> {
        const stream = input.provider.generateContentStream(
            input.providerConfig,
            input.history,
            input.systemInstruction,
            {
                cachedContentName: input.cachedContentName,
                responseSchema: getNarratorSchema(input.outputLanguage),
                responseMimeType: 'application/json',
                intent: input.intent,
                signal: input.signal
            }
        );

        return this.streamProcessor.processNarratorStream(
            stream,
            input.modelMsgId,
            input.outputLanguage,
            input.updateMessages,
            input.seedThought ?? '',
            input.sceneSnapshot ?? null
        );
    }

    /**
     * Coerces best-effort-parsed resolver JSON into a fully-formed
     * {@link ResolverResponse}. A misbehaving model may omit nested fields;
     * we fill defaults so the orchestrator never trusts the model's
     * self-reported flags. Truncation is the program's job — see
     * `truncateAtBreak`.
     */
    private normalizeResolver(parsed: Partial<ResolverResponse>): ResolverResponse {
        const idealStrength: IdealStrength = parsed.ideal_strength === 'perfectionist' || parsed.ideal_strength === 'desperate'
            ? parsed.ideal_strength
            : 'pragmatic';
        return {
            ideal_outcome: parsed.ideal_outcome ?? '',
            ideal_strength: idealStrength,
            analysis: this.normalizeAnalysis(parsed.analysis)
        };
    }

    private normalizeAnalysis(raw: unknown): StructuredAnalysis {
        const a = (raw && typeof raw === 'object' ? raw : {}) as Partial<StructuredAnalysis>;
        return {
            scene_snapshot: this.normalizeScene(a.scene_snapshot),
            steps: Array.isArray(a.steps) ? a.steps.map(s => this.normalizeStep(s)) : [],
            random_event: {
                triggered: a.random_event?.triggered === true,
                description: a.random_event?.description ?? ''
            }
        };
    }

    private normalizeScene(raw: Partial<SceneSnapshot> | undefined): SceneSnapshot {
        return {
            date_in_world: raw?.date_in_world ?? '',
            time_hhmm: raw?.time_hhmm ?? '',
            location: raw?.location ?? '',
            environment: raw?.environment ?? '',
            pc_in_header: raw?.pc_in_header ?? '',
            present_npcs: Array.isArray(raw?.present_npcs)
                ? raw.present_npcs.map(n => ({ name: n?.name ?? '', state: n?.state ?? '' }))
                : [],
            key_objects: Array.isArray(raw?.key_objects)
                ? raw.key_objects.map(o => ({ name: o?.name ?? '', state: o?.state ?? '' }))
                : []
        };
    }

    private normalizeStep(raw: Partial<AnalysisStep> | undefined): AnalysisStep {
        return {
            action: raw?.action ?? '',
            pc_dialogue: raw?.pc_dialogue ?? '',
            mood: raw?.mood ?? '',
            risk_factors: Array.isArray(raw?.risk_factors) ? raw.risk_factors.filter(r => typeof r === 'string') : [],
            outcome: raw?.outcome ?? '',
            breaks_ideal: raw?.breaks_ideal === true,
            npc_reactions: Array.isArray(raw?.npc_reactions)
                ? raw.npc_reactions.map(r => ({
                    actor: r?.actor ?? '',
                    physical: r?.physical ?? '',
                    dialogue: r?.dialogue ?? '',
                    motivation: r?.motivation ?? ''
                }))
                : [],
            object_reactions: Array.isArray(raw?.object_reactions)
                ? raw.object_reactions.map(o => ({ name: o?.name ?? '', change: o?.change ?? '' }))
                : []
        };
    }
}

// Re-export for tests / callers that need it directly.
export { interruptedAtStep, isInterrupted };
