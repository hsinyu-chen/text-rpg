import { Injectable, inject } from '@angular/core';
import { LLMUsageMetadata } from '@hcs/llm-core';
import { ContextBuilderService } from '../context-builder.service';
import { StreamProcessResult } from '../stream-processor.service';
import { ChatMessage } from '@app/core/models/types';
import { StatChange, StatValues } from '@app/core/models/stats.types';
import { TurnEngine, TurnRunInput } from './turn-engine.interface';
import { TwoCallOrchestratorService } from './two-call-orchestrator.service';
import { truncateAtBreak, StructuredAnalysis } from '@app/core/constants/engine-protocol-structured';
import { formatResolverIntent, formatStructuredAnalysis } from './format-structured-analysis';
import { StatLedgerService } from '../stats/stat-ledger.service';
import { priorStatDeltaLists } from '../stats/stats-opt-in.util';

/**
 * Two-call turn engine — splits a turn into a resolver call (atomic action
 * breakdown + per-step breaks_ideal judgment) followed by a narrator call
 * (renders the post-truncation analysis into prose).
 *
 * Contract differs from {@link SingleCallTurnEngine} in one important way:
 * `input.history` here is the BASE history with the raw user message at the
 * tail. The engine does its own intent + protocol augmentation per call,
 * since the resolver and narrator need different user-message tails.
 */
@Injectable({ providedIn: 'root' })
export class TwoCallTurnEngine implements TurnEngine {
    private orchestrator = inject(TwoCallOrchestratorService);
    private contextBuilder = inject(ContextBuilderService);
    private statLedger = inject(StatLedgerService);

    async runTurn(input: TurnRunInput): Promise<StreamProcessResult> {
        const baseHistory = input.history;

        // Push the empty model message before the resolver call so the user sees
        // the spinner during call 1; runNarrator updates this same message in place.
        input.updateMessages(prev => [...prev, {
            id: input.modelMsgId,
            role: 'model',
            content: '',
            thought: '',
            isThinking: true,
            cotOpen: true
        } as ChatMessage]);

        const resolverHistory = this.contextBuilder.buildResolverContext(input.buildContext, {
            baseHistory,
            intent: input.intent,
            lang: input.outputLanguage
        });

        const resolverResult = await this.orchestrator.runResolver({
            provider: input.provider,
            providerConfig: input.providerConfig,
            cachedContentName: input.cachedContentName,
            systemInstruction: input.systemInstruction,
            history: resolverHistory,
            outputLanguage: input.outputLanguage,
            intent: input.intent,
            signal: input.signal,
            enableStats: input.buildContext.enableStatsSystem,
            modelMsgId: input.modelMsgId,
            updateMessages: input.updateMessages
        });

        const truncatedAnalysis = truncateAtBreak(resolverResult.resolverOutput.analysis);

        // Numeric-stats fold seam. thisTurnChanges = the surviving (truncated)
        // steps' stat_changes, in order; postValues = baseline folded over the
        // full prior history PLUS this turn; triggered = events that crossed
        // between the pre-turn and post-turn values. Computed here so the
        // narrator (phase 2) renders post-turn numbers, and persisted raw on the
        // model message so a re-fold can reproduce the applied/dropped audit.
        const fold = this.foldStats(input.buildContext, truncatedAnalysis);

        const narratorHistory = this.contextBuilder.buildNarratorContext(input.buildContext, {
            baseHistory,
            idealOutcome: resolverResult.resolverOutput.ideal_outcome,
            idealStrength: resolverResult.resolverOutput.ideal_strength,
            truncatedAnalysis,
            lang: input.outputLanguage,
            postStatValues: fold?.postValues,
            triggeredEvents: fold?.triggered
        });

        // Prefix narrator's CoT with the resolver's so both phases share one panel.
        // Use a clear separator + heading so the user can tell where each phase ended.
        const seedThought = resolverResult.thought
            ? `### Resolver thought\n\n${resolverResult.thought}\n\n---\n\n### Narrator thought\n\n`
            : '';

        // Re-open the CoT panel for the narrator phase. processNarratorStream will
        // close it again on the first non-thought chunk.
        input.updateMessages(prev => {
            const arr = [...prev];
            const last = arr[arr.length - 1];
            if (last?.role === 'model' && last.id === input.modelMsgId) {
                arr[arr.length - 1] = { ...last, cotOpen: true };
            }
            return arr;
        });

        const narratorResult = await this.orchestrator.runNarrator({
            provider: input.provider,
            providerConfig: input.providerConfig,
            cachedContentName: input.cachedContentName,
            systemInstruction: input.systemInstruction,
            history: narratorHistory,
            outputLanguage: input.outputLanguage,
            intent: input.intent,
            modelMsgId: input.modelMsgId,
            signal: input.signal,
            updateMessages: input.updateMessages,
            seedThought,
            sceneSnapshot: truncatedAnalysis.scene_snapshot
        });

        const combinedUsage: LLMUsageMetadata = {
            // Spread narrator usage first to preserve rate/progress fields
            // (promptSpeed, completionSpeed, promptProgress) — summing those
            // across calls is meaningless. Then sum every cumulative token
            // counter for accurate per-turn telemetry.
            ...narratorResult.turnUsage,
            prompt: (resolverResult.usage.prompt || 0) + (narratorResult.turnUsage.prompt || 0),
            candidates: (resolverResult.usage.candidates || 0) + (narratorResult.turnUsage.candidates || 0),
            cached: (resolverResult.usage.cached || 0) + (narratorResult.turnUsage.cached || 0),
            promptCache: (resolverResult.usage.promptCache || 0) + (narratorResult.turnUsage.promptCache || 0),
            promptTotal: (resolverResult.usage.promptTotal || 0) + (narratorResult.turnUsage.promptTotal || 0),
            promptProcessed: (resolverResult.usage.promptProcessed || 0) + (narratorResult.turnUsage.promptProcessed || 0),
            totalDuration: (resolverResult.usage.totalDuration || 0) + (narratorResult.turnUsage.totalDuration || 0)
        };

        const intentHeader = formatResolverIntent(
            resolverResult.resolverOutput.ideal_outcome,
            resolverResult.resolverOutput.ideal_strength,
            input.outputLanguage
        );
        const analysisBody = formatStructuredAnalysis(truncatedAnalysis, input.outputLanguage);
        const finalTrace = [intentHeader, analysisBody].filter(s => s.length > 0).join('\n\n');

        // Post-turn KV cache holds only the narrator call's tokens — the resolver
        // call's prefix was overwritten when narrator ran. Sidebar consumes this
        // so the context bar reflects single-call occupancy, not the cost-billable
        // sum of both calls.
        const narratorContextTokens =
            (narratorResult.turnUsage.prompt || 0) + (narratorResult.turnUsage.candidates || 0);

        return {
            ...narratorResult,
            // Final formatted analysis lands in the analysis field so it
            // renders in the existing "Atomic Breakdown & Check" panel.
            finalAnalysis: finalTrace || resolverResult.rawJson,
            turnUsage: combinedUsage,
            finalFinishReason: narratorResult.finalFinishReason || resolverResult.finishReason,
            contextTokens: narratorContextTokens,
            stat_delta: fold?.thisTurnChanges
        };
    }

    /**
     * Fold the numeric-stats ledger for this turn. Returns null (no stats work,
     * byte-identical to the pre-stats path) unless the Book opted in AND the
     * snapshot carries a parsed ledger + baseline.
     *
     * The fold basis is the stat_delta of EVERY prior non-ref-only model message
     * in the FULL captured history — not the possibly-truncated base history — so
     * a deleted or retried mid-history message naturally drops its delta and the
     * running totals roll back. prevValues are the pre-turn numbers (the resolver
     * already ran against them); postValues fold this turn's surviving changes on
     * top; triggered events are evaluated across that pre/post pair.
     */
    private foldStats(
        ctx: TurnRunInput['buildContext'],
        truncatedAnalysis: StructuredAnalysis
    ): { thisTurnChanges: StatChange[]; postValues: StatValues; triggered: string[] } | null {
        const { statsParsed, statsBaseline } = ctx;
        if (!ctx.enableStatsSystem || !statsParsed || !statsBaseline) return null;

        const priorDeltaLists = priorStatDeltaLists(ctx.messages);
        const thisTurnChanges = truncatedAnalysis.steps.flatMap(s => s.stat_changes ?? []);

        // Clamping is applied after every change with no remembered overflow, so
        // folding this turn's changes onto prevValues is identical to re-folding
        // the whole history from baseline — and skips the redundant prior pass.
        // fold deep-copies its baseline arg, so prevValues stays intact for events.
        const prevValues = this.statLedger.computeCurrent(statsParsed, statsBaseline, priorDeltaLists);
        const postValues = this.statLedger.fold(statsParsed, prevValues, thisTurnChanges).values;
        const triggered = this.statLedger.evaluateEvents(
            statsParsed,
            prevValues,
            postValues,
            statsParsed.events
        );

        return { thisTurnChanges, postValues, triggered };
    }
}
