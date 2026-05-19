import { Injectable, inject } from '@angular/core';
import type { LLMContent, LLMProvider, LLMProviderConfig, LLMUsageMetadata } from '@hcs/llm-core';
import { ContentParserService } from '../content-parser.service';
import { mergeUsage } from '../llm-usage-merge';
import { SAVE_MANIFEST_SCHEMA, validateManifest } from './schemas/manifest.schema';
import type { SaveManifest } from './multi-agent-save.types';
import { SaveProgressTracker } from './progress/save-progress-tracker.service';

export interface SaveAgentInput {
    provider: LLMProvider;
    providerConfig: LLMProviderConfig;
    systemInstruction: string;
    cachedContentName?: string;
    history: LLMContent[];
    signal: AbortSignal;
}

export interface SaveAgentResult {
    manifest: SaveManifest;
    rawJson: string;
    thought: string;
    usage: LLMUsageMetadata;
    finishReason?: string;
}

/**
 * Streams one structured-output LLM call asking the model to emit a
 * {@link SaveManifest} JSON. Mirrors `TwoCallOrchestratorService.runResolver`
 * structurally — same provider API, same chunk loop, same usage merge — but
 * the streamed text accumulates into a single JSON object instead of being
 * rendered into a chat message.
 *
 * Progress is reported through {@link SaveProgressTracker} so the dialog sees
 * the same per-entry card as every dispatcher stage. The runner doesn't push
 * a model message to chat history — multi-agent save's contract is that the
 * save run leaves no trace in the conversation.
 */
@Injectable({ providedIn: 'root' })
export class SaveAgentRunnerService {
    private parser = inject(ContentParserService);
    private progress = inject(SaveProgressTracker);

    async run(input: SaveAgentInput): Promise<SaveAgentResult> {
        const entryId = this.progress.startEntry('manifest', { toolName: 'SaveAgent' });

        let stream: AsyncIterable<{
            text?: string;
            thought?: boolean;
            usageMetadata?: LLMUsageMetadata;
            finishReason?: string;
        }>;
        try {
            stream = input.provider.generateContentStream(
                input.providerConfig,
                input.history,
                input.systemInstruction,
                {
                    cachedContentName: input.cachedContentName,
                    responseSchema: SAVE_MANIFEST_SCHEMA,
                    responseMimeType: 'application/json',
                    intent: 'save',
                    signal: input.signal,
                },
            );
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.progress.finishEntry(entryId, 'failed', `provider error: ${msg}`);
            throw err;
        }

        let accumulator = '';
        let thoughtAccumulator = '';
        let usage: LLMUsageMetadata = { prompt: 0, candidates: 0, cached: 0 };
        let finishReason: string | undefined;

        try {
            for await (const chunk of stream) {
                if (chunk.finishReason) finishReason = chunk.finishReason;
                if (chunk.text) {
                    if (chunk.thought) {
                        thoughtAccumulator += chunk.text;
                        this.progress.appendThought(entryId, chunk.text);
                    } else {
                        accumulator += chunk.text;
                        this.progress.appendOutput(entryId, chunk.text);
                    }
                }
                if (chunk.usageMetadata) {
                    usage = mergeUsage(usage, chunk.usageMetadata);
                    this.progress.setUsage(entryId, {
                        prompt: usage.prompt,
                        candidates: usage.candidates,
                        cached: usage.cached,
                    });
                    if (chunk.usageMetadata.promptProgress !== undefined) {
                        this.progress.setPpProgress(entryId, chunk.usageMetadata.promptProgress);
                    }
                }
            }
        } catch (err: unknown) {
            // Distinguish user-initiated cancellation from a real failure —
            // the entry reads "skipped: user_aborted" instead of "failed:
            // stream error: AbortError" so the dialog doesn't lie about the
            // outcome. The orchestrator's catch still suppresses the error
            // snackbar via isAbortError.
            if (input.signal.aborted) {
                this.progress.skip(entryId, 'user_aborted');
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                this.progress.finishEntry(entryId, 'failed', `stream error: ${msg}`);
            }
            throw err;
        }

        let parsed: unknown;
        try {
            parsed = this.parser.bestEffortJsonParser(accumulator);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.progress.finishEntry(entryId, 'failed', `JSON parse: ${msg}`);
            throw new Error(`SaveAgent JSON parse failed: ${msg}`);
        }

        const validation = validateManifest(parsed);
        if (!validation.ok) {
            this.progress.finishEntry(entryId, 'failed', `manifest invalid: ${validation.error}`);
            throw new Error(`SaveAgent manifest invalid: ${validation.error}`);
        }

        this.progress.finishEntry(entryId, 'done');
        return {
            manifest: validation.manifest,
            rawJson: accumulator,
            thought: thoughtAccumulator,
            usage,
            finishReason,
        };
    }
}
