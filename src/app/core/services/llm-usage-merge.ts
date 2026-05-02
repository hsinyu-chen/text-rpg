import { LLMUsageMetadata } from '@hcs/llm-core';

/**
 * "Sticky" merge: only overwrite a previous field when the incoming value
 * is non-zero / non-undefined, so the late chunks of a stream that report
 * only the final usageMetadata don't zero out earlier reads. This shape
 * matches what every provider in this codebase emits — totals climb
 * monotonically across chunks.
 *
 * Centralized here so the v1 stream processor, the v2 narrator stream,
 * and the resolver call all use the same accumulation rules — the field
 * lists had already drifted across previous copies.
 */
export function mergeUsage(prev: LLMUsageMetadata, incoming: LLMUsageMetadata | undefined): LLMUsageMetadata {
    if (!incoming) return prev;
    return {
        ...prev,
        prompt: incoming.prompt || prev.prompt,
        candidates: incoming.candidates || prev.candidates,
        cached: incoming.cached || prev.cached,
        promptSpeed: incoming.promptSpeed || prev.promptSpeed,
        completionSpeed: incoming.completionSpeed || prev.completionSpeed,
        totalDuration: incoming.totalDuration || prev.totalDuration,
        promptProgress: incoming.promptProgress !== undefined ? incoming.promptProgress : prev.promptProgress,
        promptTotal: incoming.promptTotal || prev.promptTotal,
        promptProcessed: incoming.promptProcessed || prev.promptProcessed,
        promptCache: incoming.promptCache || prev.promptCache
    };
}
