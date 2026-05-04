import { Injectable, inject } from '@angular/core';
import { LLMContent, LLMProvider, LLMProviderConfig, LLMUsageMetadata } from '@hcs/llm-core';
import { ContentParserService } from '../content-parser.service';
import { StreamProcessorService, StreamProcessResult } from '../stream-processor.service';
import { ChatMessage } from '@app/core/models/types';
import { getResolverSchema, getNarratorSchema, ResolverOutput } from '@app/core/constants/engine-protocol-two-call';
import { formatResolverTrace } from './format-resolver-trace';
import { mergeUsage } from '../llm-usage-merge';

export interface ResolverRunResult {
    resolverOutput: ResolverOutput;
    rawJson: string;
    /** Concatenated `thought` chunks from the resolver call (CoT). Empty when the model emits no thought stream. */
    thought: string;
    usage: LLMUsageMetadata;
    finishReason?: string;
}

/**
 * Common per-call runtime context that the orchestrator forwards into
 * `provider.generateContentStream`. Captured once by the caller (game-engine)
 * for the whole turn so resolver and narrator agree on which provider /
 * cache / system-prompt they target.
 */
interface OrchestratorRuntime {
    provider: LLMProvider;
    providerConfig: LLMProviderConfig;
    cachedContentName?: string;
    systemInstruction: string;
}

/**
 * Drives the two LLM calls of two-call mode. The {@link TwoCallTurnEngine}
 * coordinates context building + truncation around these primitives.
 *
 * `runResolver` does NOT touch the chat message — the resolver phase is
 * an internal computation. The orchestrator exposes the raw JSON so a
 * presenter (D13) can show step trace separately.
 *
 * `runNarrator` updates the existing model message in place via
 * {@link StreamProcessorService.processNarratorStream}; the caller is
 * expected to have already pushed the empty model message before the
 * resolver phase began.
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
                        const partial = this.parser.bestEffortJsonParser(accumulator) as Partial<ResolverOutput>;
                        const trace = formatResolverTrace(partial);
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

        let parsed: Partial<ResolverOutput> | null = null;
        try {
            parsed = this.parser.bestEffortJsonParser(accumulator) as Partial<ResolverOutput>;
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
            input.seedThought ?? ''
        );
    }

    /**
     * Coerces a best-effort-parsed resolver JSON into a fully-formed
     * {@link ResolverOutput}. A misbehaving model may omit `interrupted`
     * or `interrupted_at_step`; we recompute them from `steps` so the
     * orchestrator never trusts the model's self-reporting flags. The
     * actual hard-stop truncation runs in `truncateAtFirstBroken`.
     */
    private normalizeResolver(parsed: Partial<ResolverOutput>): ResolverOutput {
        const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
        const firstBrokenIdx = steps.findIndex(s => s?.ideal_status === 'broken');
        const interrupted = firstBrokenIdx >= 0;
        return {
            ideal_outcome: parsed.ideal_outcome ?? '',
            ideal_strength: parsed.ideal_strength ?? 'pragmatic',
            steps,
            interrupted,
            interrupted_at_step: interrupted ? firstBrokenIdx + 1 : 0
        };
    }
}
