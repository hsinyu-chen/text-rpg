import { LLMContent, LLMProvider, LLMProviderConfig } from '@hcs/llm-core';
import { ChatMessage } from '@app/core/models/types';
import { StreamProcessResult } from '../stream-processor.service';
import { BuildContext } from '../context-builder.service';

/**
 * Per-call execution context for a single user turn.
 *
 * The four "runtime" fields below — `provider`, `providerConfig`,
 * `cachedContentName`, `systemInstruction` — are deliberately passed in by
 * the caller rather than pulled from `LLMProviderRegistryService` /
 * `GameStateService` / `ContextBuilderService` inside the engine. Keeps
 * engines functionally pure: same input → same provider call, no DI
 * singleton substitution required to write a spec.
 *
 * `systemInstruction` is the FINAL string that goes into
 * `provider.generateContentStream` — caller has already chosen whether to
 * include the KB body (i.e. caller has folded `shouldOmitKbFromSystemInstruction`
 * + `getEffectiveSystemInstruction` into one resolved value). Engines do not
 * inspect provider capabilities or cache state to make that decision.
 */
export interface TurnRunInput {
    history: LLMContent[];
    intent: string;
    outputLanguage: string;
    modelMsgId: string;
    signal: AbortSignal;
    updateMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;

    provider: LLMProvider;
    providerConfig: LLMProviderConfig;
    cachedContentName?: string;
    systemInstruction: string;

    /**
     * Snapshot of `GameStateService` / `LLMProviderRegistryService` values
     * the engine's downstream `ContextBuilderService` calls need. Required
     * by the two-call path (which calls `buildResolverContext` /
     * `buildNarratorContext` mid-turn). Single-call ignores it but the
     * field is required so `TurnEngine` stays a single uniform shape and
     * the caller can capture once for both code paths.
     */
    buildContext: BuildContext;
}

export interface TurnEngine {
    runTurn(input: TurnRunInput): Promise<StreamProcessResult>;
}
