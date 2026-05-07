import { LLMFunctionCall, LLMPart } from '@hcs/llm-core';

/**
 * Streamed chunk shape consumed by the processor. Mirrors the
 * `provider.generateContentStream` contract from llm-core, narrowed to
 * just the fields we read here.
 */
export interface AgentStreamChunk {
    text?: string;
    thought?: boolean;
    functionCall?: LLMFunctionCall;
    thoughtSignature?: string;
    usageMetadata?: {
        promptProgress?: number;
        candidates?: number;
    } & {
        // Legacy field name still emitted by older providers.
        candidatesTokenCount?: number;
    };
}

export interface ProcessAgentStreamOptions {
    /**
     * Whether the model supports parallel tool calls. When false, only the
     * first functionCall in the stream is kept (preserves single-tool
     * semantics). When true, every functionCall chunk is collected.
     */
    allowParallel: boolean;
    /**
     * Throttle interval (ms) for tool-call heartbeat events. Without this,
     * a long functionCall assembly would emit one heartbeat per chunk and
     * spam the caller's UI mutation. Defaults to 100ms.
     */
    heartbeatIntervalMs?: number;
}

/** Per-chunk progress signal: chunk count + token total + prompt progress. */
export interface ProgressEvent {
    kind: 'progress';
    chunkCount: number;
    /** Set when the chunk reported a token total this turn. */
    tokenCount?: number;
    /** Set when the chunk reported prompt-progress (0..1). */
    promptProgress?: number;
}

/** Thought delta yielded after appending to the accumulated thought. */
export interface ThoughtEvent {
    kind: 'thought';
    accumulatedThought: string;
}

/**
 * Text delta yielded after appending to the accumulated text. `collapseThought`
 * is true the first time text follows thought in the same turn — the caller
 * uses it to flip the log entry's `isThoughtCollapsed` flag once.
 */
export interface TextEvent {
    kind: 'text';
    accumulatedText: string;
    collapseThought: boolean;
}

/**
 * Tool-call heartbeat. Throttled to `heartbeatIntervalMs` between renders;
 * the very first functionCall chunk always fires (`isFirst: true`) so the
 * "Preparing tool: …" line appears immediately. `toolNames` is the running
 * list of all collected functionCall names.
 */
export interface ToolHeartbeatEvent {
    kind: 'tool-heartbeat';
    isFirst: boolean;
    toolNames: string[];
    chunkCount: number;
    tokenCount: number;
}

export type AgentStreamEvent = ProgressEvent | ThoughtEvent | TextEvent | ToolHeartbeatEvent;

/** Final accumulator state returned when the stream ends. */
export interface AgentStreamResult {
    accumulatedText: string;
    accumulatedThought: string;
    /**
     * True if at least one text chunk followed a thought chunk during the
     * stream — i.e. a collapse-thought event was already emitted. The
     * caller uses this to know whether a final "collapse the thought block"
     * mutation is still owed (when the stream ended with thought text but
     * no follow-up regular text).
     */
    hasCollapsedThought: boolean;
    nativeFunctionCalls: LLMFunctionCall[];
    /**
     * functionCall chunks wrapped as LLMParts so the caller can splice them
     * directly into agentHistory. Preserves `thoughtSignature` from each
     * chunk — Gemini needs this round-tripped on the next turn.
     */
    nativeFunctionCallParts: LLMPart[];
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 100;

/**
 * Async generator that consumes an LLM stream and yields UI-relevant
 * events (progress / thought / text / tool-heartbeat) as they happen,
 * returning the final accumulator state when the stream ends.
 *
 * Pure: holds no Angular references and never mutates caller state.
 * Caller pattern:
 *
 *     const gen = processAgentStream(stream, { allowParallel });
 *     let result: AgentStreamResult;
 *     while (true) {
 *         const next = await gen.next();
 *         if (next.done) { result = next.value; break; }
 *         switch (next.value.kind) { ... }   // mutate signals
 *     }
 *
 * The events mirror the per-chunk side effects the inline version did
 * before extraction; ordering inside a single chunk is preserved
 * (progress → thought | text | heartbeat). Errors in the underlying
 * stream propagate (caller wraps in try/catch as before).
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

        // Progress: extract token count + promptProgress from usageMetadata.
        // candidatesTokenCount is the legacy field name still emitted by
        // older providers; prefer the modern `candidates` when present.
        const usage = chunk.usageMetadata;
        let chunkTokenCount: number | undefined;
        if (usage?.candidates !== undefined) {
            chunkTokenCount = usage.candidates;
        } else if (usage?.candidatesTokenCount !== undefined) {
            chunkTokenCount = usage.candidatesTokenCount;
        }
        if (chunkTokenCount !== undefined) tokenCount = chunkTokenCount;

        yield {
            kind: 'progress',
            chunkCount,
            tokenCount: chunkTokenCount,
            promptProgress: usage?.promptProgress
        };

        if (chunk.functionCall) {
            // Collect every tool call when the model supports parallel
            // calls; otherwise keep only the first to preserve single-tool
            // semantics.
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
                // First text-after-thought triggers the one-shot collapse
                // signal; subsequent text events leave it false.
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
