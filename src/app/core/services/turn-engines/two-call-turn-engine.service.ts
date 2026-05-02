import { Injectable, inject } from '@angular/core';
import { LLMUsageMetadata } from '@hcs/llm-core';
import { ContextBuilderService } from '../context-builder.service';
import { StreamProcessResult } from '../stream-processor.service';
import { ChatMessage } from '../../models/types';
import { TurnEngine, TurnRunInput } from './turn-engine.interface';
import { TwoCallOrchestratorService } from './two-call-orchestrator.service';
import { truncateAtFirstBroken } from './truncate-steps';
import { formatResolverTrace } from './format-resolver-trace';

/**
 * v2 turn engine — splits a turn into a resolver call (atomic action
 * breakdown + per-step ideal_status judgment) followed by a narrator
 * call (renders the post-truncation steps into prose).
 *
 * Contract differs from {@link SingleCallTurnEngine} in one important
 * way: `input.history` here is the BASE history with the raw user
 * message at the tail. The engine does its own intent + protocol
 * augmentation per call, since the resolver and narrator need
 * different user-message tails.
 */
@Injectable({ providedIn: 'root' })
export class TwoCallTurnEngine implements TurnEngine {
    private orchestrator = inject(TwoCallOrchestratorService);
    private contextBuilder = inject(ContextBuilderService);

    async runTurn(input: TurnRunInput): Promise<StreamProcessResult> {
        const baseHistory = input.history;

        // Push the empty model message before the resolver call so the user sees
        // the spinner during call 1; runNarrator updates this same message in place.
        input.updateMessages(prev => [...prev, {
            id: input.modelMsgId,
            role: 'model',
            content: '',
            thought: '',
            isThinking: true
        } as ChatMessage]);

        const resolverHistory = this.contextBuilder.buildResolverContext({
            baseHistory,
            intent: input.intent,
            lang: input.outputLanguage
        });

        const resolverResult = await this.orchestrator.runResolver({
            history: resolverHistory,
            outputLanguage: input.outputLanguage,
            intent: input.intent,
            signal: input.signal,
            modelMsgId: input.modelMsgId,
            updateMessages: input.updateMessages
        });

        const truncated = truncateAtFirstBroken(resolverResult.resolverOutput.steps);

        const narratorHistory = this.contextBuilder.buildNarratorContext({
            baseHistory,
            resolver: {
                ...resolverResult.resolverOutput,
                interrupted: truncated.interrupted,
                interrupted_at_step: truncated.interruptedAtStep
            },
            executedSteps: truncated.executed
        });

        const narratorResult = await this.orchestrator.runNarrator({
            history: narratorHistory,
            outputLanguage: input.outputLanguage,
            intent: input.intent,
            modelMsgId: input.modelMsgId,
            signal: input.signal,
            updateMessages: input.updateMessages
        });

        const combinedUsage: LLMUsageMetadata = {
            // Spread the narrator usage first to preserve transient/diagnostic fields
            // (promptProgress, promptCache, promptTotal, promptProcessed); then sum
            // the cumulative counters across both calls.
            ...narratorResult.turnUsage,
            prompt: (resolverResult.usage.prompt || 0) + (narratorResult.turnUsage.prompt || 0),
            candidates: (resolverResult.usage.candidates || 0) + (narratorResult.turnUsage.candidates || 0),
            cached: (resolverResult.usage.cached || 0) + (narratorResult.turnUsage.cached || 0),
            totalDuration: (resolverResult.usage.totalDuration || 0) + (narratorResult.turnUsage.totalDuration || 0)
        };

        const finalTrace = formatResolverTrace({
            ...resolverResult.resolverOutput,
            interrupted: truncated.interrupted,
            interrupted_at_step: truncated.interruptedAtStep
        });

        return {
            ...narratorResult,
            // Final formatted resolver trace lands in the analysis field so it
            // renders in the existing "Atomic Breakdown & Check" panel.
            finalAnalysis: finalTrace || resolverResult.rawJson,
            turnUsage: combinedUsage,
            finalFinishReason: narratorResult.finalFinishReason || resolverResult.finishReason
        };
    }
}
