import { LLMFunctionCall, LLMPart, LLMStreamChunk, LLMUsageMetadata } from '@hcs/llm-core';

/**
 * Same as `LLMStreamChunk` from llm-core, with `usageMetadata` widened
 * to also accept the legacy `candidatesTokenCount` field still emitted
 * by some older providers (the modern field is `candidates`).
 */
export type AgentStreamChunk = Omit<LLMStreamChunk, 'usageMetadata'> & {
    usageMetadata?: LLMUsageMetadata & { candidatesTokenCount?: number };
};

export interface ProcessAgentStreamOptions {
    allowParallel: boolean;
    /** Default 100ms. */
    heartbeatIntervalMs?: number;
}

export interface ProgressEvent {
    kind: 'progress';
    chunkCount: number;
    tokenCount?: number;
    promptProgress?: number;
    /**
     * True when the chunk also carried text or a functionCall. The caller
     * MUST clear its prompt-progress display in that case — when a chunk
     * carries BOTH a `promptProgress` value and text/functionCall, the
     * clear wins. Without this, prompt-progress can linger during tool-
     * call streaming when functionCall chunks arrive between throttled
     * heartbeats.
     */
    clearPromptProgress?: boolean;
}

export interface ThoughtEvent {
    kind: 'thought';
    accumulatedThought: string;
}

export interface TextEvent {
    kind: 'text';
    accumulatedText: string;
    /** True the first time text follows thought in the same turn — caller
     *  flips `isThoughtCollapsed` once. */
    collapseThought: boolean;
}

export interface ToolHeartbeatEvent {
    kind: 'tool-heartbeat';
    /** First functionCall chunk always fires; later chunks throttle. */
    isFirst: boolean;
    toolNames: string[];
    chunkCount: number;
    tokenCount: number;
}

export type AgentStreamEvent = ProgressEvent | ThoughtEvent | TextEvent | ToolHeartbeatEvent;

export interface AgentStreamResult {
    accumulatedText: string;
    accumulatedThought: string;
    /** True iff a `collapseThought` text event was already emitted —
     *  caller uses this to know whether a final collapse mutation is
     *  still owed (stream ended on thought without follow-up text). */
    hasCollapsedThought: boolean;
    nativeFunctionCalls: LLMFunctionCall[];
    /** Wrapped as `LLMPart` so caller can splice into agentHistory.
     *  Preserves `thoughtSignature` — Gemini needs it round-tripped on
     *  the next turn. */
    nativeFunctionCallParts: LLMPart[];
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 100;

/**
 * Async generator that consumes an LLM stream and yields UI-relevant
 * events as they happen, returning the final accumulator state when the
 * stream ends. No Angular references; never mutates caller state. Errors
 * in the underlying stream propagate.
 */
export async function* processAgentStream(
    stream: AsyncIterable<AgentStreamChunk>,
    options: ProcessAgentStreamOptions
): AsyncGenerator<AgentStreamEvent, AgentStreamResult, void> {
    const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

    let accumulatedText = '';
    let accumulatedThought = '';
    let hasCollapsedThought = false;
    const nativeFunctionCalls: LLMFunctionCall[] = [];
    const nativeFunctionCallParts: LLMPart[] = [];

    let chunkCount = 0;
    let tokenCount = 0;
    let firstFunctionCallSeen = false;
    let lastToolCallRenderAt = 0;

    for await (const chunk of stream) {
        chunkCount++;

        const usage = chunk.usageMetadata;
        const chunkTokenCount = usage?.candidates ?? usage?.candidatesTokenCount;
        if (chunkTokenCount !== undefined) tokenCount = chunkTokenCount;

        yield {
            kind: 'progress',
            chunkCount,
            tokenCount: chunkTokenCount,
            promptProgress: usage?.promptProgress,
            clearPromptProgress: !!chunk.functionCall || chunk.text !== undefined
        };

        if (chunk.functionCall) {
            // Single-tool semantics when allowParallel is false: keep
            // only the first functionCall, ignore subsequent ones.
            if (options.allowParallel || nativeFunctionCalls.length === 0) {
                nativeFunctionCalls.push(chunk.functionCall);
                nativeFunctionCallParts.push({
                    functionCall: chunk.functionCall,
                    thoughtSignature: chunk.thoughtSignature
                });
            }

            const isFirst = !firstFunctionCallSeen;
            const now = Date.now();
            if (isFirst || now - lastToolCallRenderAt >= heartbeatIntervalMs) {
                firstFunctionCallSeen = true;
                lastToolCallRenderAt = now;
                yield {
                    kind: 'tool-heartbeat',
                    isFirst,
                    toolNames: nativeFunctionCalls.map(fc => fc.name),
                    chunkCount,
                    tokenCount
                };
            }
            continue;
        }

        if (chunk.text) {
            if (chunk.thought) {
                accumulatedThought += chunk.text;
                yield { kind: 'thought', accumulatedThought };
            } else {
                accumulatedText += chunk.text;
                const collapseThought = !!accumulatedThought && !hasCollapsedThought;
                yield { kind: 'text', accumulatedText, collapseThought };
                if (collapseThought) hasCollapsedThought = true;
            }
        }
    }

    return {
        accumulatedText,
        accumulatedThought,
        hasCollapsedThought,
        nativeFunctionCalls,
        nativeFunctionCallParts
    };
}
