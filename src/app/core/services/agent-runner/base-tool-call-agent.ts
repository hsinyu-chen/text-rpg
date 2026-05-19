import { signal } from '@angular/core';
import { LLMContent, LLMFunctionCall, LLMFunctionDeclaration, LLMPart, LLMProvider } from '@hcs/llm-core';
import {
    AgentLogEntry,
    Awaitable,
    FileAgentContext,
    ParsedAction,
    ToolExecutionResult,
} from '../file-agent/file-agent.types';
import {
    AgentStreamChunk,
    AgentStreamEvent,
    AgentStreamResult,
    processAgentStream,
} from './agent-stream-processor';
import { buildJsonSchema } from './tool-schema-builder';

/**
 * Per-turn mutable bookkeeping passed down the loop helpers. Lives on the
 * stack inside `processAgentTurn` — never on the instance — so concurrent
 * turns (if any future agent supports them) don't tread on each other.
 */
export interface TurnContext {
    currentLogIndex: number;
    accumulatedText: string;
    accumulatedThought: string;
    hasCollapsedThought: boolean;
    nativeFunctionCallParts: LLMPart[];
}

/**
 * What `resolveTurnSetup` must return for the base loop to run a turn.
 * Subclass owns profile resolution / provider lookup / gen-config wiring —
 * the base just consumes the resolved values.
 */
export interface TurnSetup {
    provider: LLMProvider;
    /** Pre-bound provider settings (the user-selected LLM profile's settings). */
    providerSettings: Record<string, unknown>;
    mode: 'native' | 'json';
    allowParallel: boolean;
    systemInstruction: string;
    /** Provider-specific `generateContentStream` config — tools / responseSchema / signal. */
    genConfig: Record<string, unknown>;
}

/**
 * Result of pre-terminal validation (e.g. file-agent's
 * WorldCompletionValidator). Default base behavior is always `valid: true`
 * — subclasses with completion gates override `validateBeforeTerminal`.
 */
export interface TerminalValidationResult {
    valid: boolean;
    /** Required when `!valid` — appended as a user-role message to drive the next turn. */
    errorMessage?: string;
}

/**
 * Generic tool-calling agent loop. Owns the conversational state (history,
 * trace logs, running flag, token / progress signals) and the recursive
 * processAgentTurn pipeline. Subclasses implement the abstract methods to
 * supply their tool catalog, dispatch logic, terminal predicate, and
 * profile / system-prompt resolution.
 *
 * Two concrete subclasses today:
 * - {@link import('./read-only-agent').ReadOnlyAgent} adds the KB-read +
 *   chat-read tool catalog (intended for save-sim per-entity agents that
 *   need read access but no UI integration).
 * - {@link import('../file-agent/file-agent.service').FileAgentService}
 *   extends ReadOnlyAgent and layers in write tools, UI-help tools,
 *   propose-chat-replace, flow-control, and the chat-panel UI integration.
 *
 * The base does NOT depend on Angular DI — `@Injectable` annotations live
 * on the leaf subclasses so each can pick its scope (singleton vs
 * per-instance) and own its DI dependencies.
 */
export abstract class BaseToolCallAgent<TAction extends ParsedAction = ParsedAction, TContext = FileAgentContext> {
    // ===== Loop state (observable by UI + traces) =====
    readonly agentHistory = signal<LLMContent[]>([]);
    readonly agentLogs = signal<AgentLogEntry[]>([]);
    readonly isAgentRunning = signal(false);
    /** Live accumulated output token count for the current turn. */
    readonly generatedTokenCount = signal(0);
    readonly generatedChunkCount = signal(0);
    /** Live prefill / prompt-processing progress (0..1) for providers that report it (e.g. llama.cpp). undefined when unknown or finished. */
    readonly promptProgress = signal<number | undefined>(undefined);

    protected abortController: AbortController | null = null;

    // ===== Subclass-supplied (abstract) =====

    /** Full tool catalog this agent exposes to the model. */
    protected abstract get tools(): LLMFunctionDeclaration[];

    /** Dispatches a single parsed action to its implementation handler. */
    protected abstract dispatchTool(action: TAction, context: TContext): Awaitable<ToolExecutionResult>;

    /** True when this action ends the agent loop (e.g. submitResponse, proposeDiff). */
    protected abstract isTerminal(action: TAction): boolean;

    /**
     * Resolve everything the base loop needs to fire one turn: provider,
     * settings, tool-call mode, system prompt, gen-config. Subclass owns
     * LLM profile selection.
     *
     * Returns null when the agent cannot run a turn right now (e.g. no
     * profile selected). The base loop bails silently in that case —
     * subclass already logged the user-facing reason.
     */
    protected abstract resolveTurnSetup(context: TContext): TurnSetup | null;

    // ===== Subclass-overridable hooks (defaulted) =====

    /**
     * Pre-terminal validation. Default: always valid. file-agent overrides
     * to enforce {@link import('../file-agent/world-completion-validator').WorldCompletionValidator}.
     */
    protected validateBeforeTerminal(action: TAction, context: TContext): TerminalValidationResult {
        // Default: no completion gate. Subclasses (file-agent's
        // WorldCompletionValidator) override to inspect `action` + `context`.
        void action;
        void context;
        return { valid: true };
    }

    /**
     * Post-process model text before it lands in agentLogs / agentHistory.
     * Default: identity. file-agent overrides to apply latex sanitization
     * + harness fallbacks (code-unwrap / empty-label backfill / etc.).
     */
    protected processModelText(text: string): string {
        return text;
    }

    /**
     * Coerce a hallucinated message arg into a clean string for trace
     * display. Default delegates to processModelText after string coercion.
     */
    protected processToolMessageArg(rawArg: unknown): string {
        return this.processModelText(typeof rawArg === 'string' ? rawArg : '');
    }

    // ===== Public lifecycle =====

    /** Abort the current turn (if any). Idempotent. */
    stopAgent(): void {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.isAgentRunning.set(false);
        this.promptProgress.set(undefined);
    }

    /** Reset agent state — history, logs. Refuses when a turn is in flight. */
    clearHistory(): void {
        if (this.isAgentRunning()) return;
        this.agentHistory.set([]);
        this.agentLogs.set([]);
    }

    // ===== Loop (driven by subclass's runAgent wrapper) =====

    /**
     * Hard cap on recursive `processAgentTurn` depth — defends against
     * runaway loops from a buggy `validateBeforeTerminal` that keeps
     * rejecting or a model that emits tool calls forever without
     * `submitResponse`. Subclasses (e.g. save-sim's per-entity agent
     * which expects tighter budgets) MAY override; 50 is generous for
     * file-agent's chat-panel + file-edit use cases. The 3-cap on JSON
     * parse retries is separate and additive.
     */
    protected readonly maxTurns: number = 50;

    /**
     * The core recursive loop. Subclass `runAgent(prompt, input)` typically
     * does its own setup (history seeding, log push, context augmentation)
     * and then calls this with the augmented context.
     */
    protected async processAgentTurn(context: TContext, retryCount = 0, turnCount = 0): Promise<void> {
        if (turnCount >= this.maxTurns) {
            this.agentLogs.update(logs => [...logs, {
                role: 'system',
                text: `Agent loop exceeded maxTurns=${this.maxTurns} — stopping to prevent runaway. The model never reached a terminal action (e.g. submitResponse) or pre-terminal validation kept rejecting. Inspect the trace to diagnose.`,
                type: 'error',
            }]);
            this.isAgentRunning.set(false);
            return;
        }
        const setup = this.resolveTurnSetup(context);
        if (!setup) return;
        const { provider, providerSettings, mode, allowParallel, systemInstruction, genConfig } = setup;

        const ctx = this.openTurnLogEntry();
        const stream = provider.generateContentStream(providerSettings, this.agentHistory(), systemInstruction, genConfig);

        const result = await this.consumeStream(stream, allowParallel, ctx);
        if (!result) return;

        if (mode === 'native' && ctx.accumulatedText) {
            ctx.accumulatedText = this.processModelText(ctx.accumulatedText);
            this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: ctx.accumulatedText }));
        }

        const parsed = parseActionsFromOutput<TAction>(mode, ctx.accumulatedText, result.nativeFunctionCalls);
        if (!parsed.ok) {
            await this.handleJsonParseError(context, retryCount, ctx, turnCount);
            return;
        }

        this.appendModelTurnToHistory(mode, ctx);

        if (parsed.actions.length === 0) {
            // Commentary-only output: implicit finish.
            this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: ctx.accumulatedText || '(no response)' }));
            this.isAgentRunning.set(false);
            return;
        }

        const terminalAction = parsed.actions.find(a => this.isTerminal(a));
        if (terminalAction) {
            await this.handleTerminalAction(context, terminalAction, mode, ctx, turnCount);
            return;
        }

        if (parsed.actions.length === 1) {
            await this.executeSingleAction(parsed.actions[0], context, mode, ctx, turnCount);
        } else {
            await this.executeBatchActions(parsed.actions, context, mode, ctx, turnCount);
        }
    }

    // ===== Loop helpers (protected so subclass can read/extend, not call) =====

    /** Append a fresh streaming model entry; return the per-turn context. */
    protected openTurnLogEntry(): TurnContext {
        let currentLogIndex = -1;
        this.agentLogs.update(logs => {
            const next = [...logs, { role: 'model', text: '', type: 'model' as const, isThoughtCollapsed: false }];
            currentLogIndex = next.length - 1;
            return next;
        });
        return {
            currentLogIndex,
            accumulatedText: '',
            accumulatedThought: '',
            hasCollapsedThought: false,
            nativeFunctionCallParts: [],
        };
    }

    /** Mutate the entry at `index` via a patch produced by `mutator`. */
    protected updateLogAt(index: number, mutator: (entry: AgentLogEntry) => AgentLogEntry): void {
        this.agentLogs.update(logs => {
            const next = [...logs];
            if (next[index]) next[index] = mutator(next[index]);
            return next;
        });
    }

    protected pushToolResultLog(response: Record<string, unknown>, toolName?: string): void {
        this.agentLogs.update(logs => [...logs, {
            role: 'system',
            text: this.formatToolResult(response),
            type: 'action' as const,
            isToolResult: true,
            isToolResultCollapsed: true,
            toolName,
        }]);
    }

    /**
     * How tool result objects render into `agentLogs[].text`. Default JSON
     * stringify; file-agent overrides with toAgentYaml for prettier output.
     */
    protected formatToolResult(response: Record<string, unknown>): string {
        return JSON.stringify(response);
    }

    /**
     * Per-event handlers for the LLM stream. Owned here because every signal
     * the handlers mutate (chunk count, token count, thought / text
     * accumulators, log entry) lives on the base.
     */
    private readonly streamEventHandlers: {
        [K in AgentStreamEvent['kind']]:
        (ev: Extract<AgentStreamEvent, { kind: K }>, ctx: TurnContext) => void
    } = {
        progress: (ev) => {
            this.generatedChunkCount.set(ev.chunkCount);
            if (ev.tokenCount !== undefined) this.generatedTokenCount.set(ev.tokenCount);
            if (ev.promptProgress !== undefined) this.promptProgress.set(ev.promptProgress);
            // When promptProgress AND text/functionCall arrive in the same chunk,
            // the clear wins — keeps the prompt bar from lingering during tool-
            // call streaming on throttled-heartbeat chunks.
            if (ev.clearPromptProgress) this.promptProgress.set(undefined);
        },
        thought: (ev, ctx) => {
            ctx.accumulatedThought = ev.accumulatedThought;
            this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, thought: ctx.accumulatedThought }));
        },
        text: (ev, ctx) => {
            ctx.accumulatedText = ev.accumulatedText;
            this.updateLogAt(ctx.currentLogIndex, e => ({
                ...e,
                text: ctx.accumulatedText,
                ...(ev.collapseThought ? { isThoughtCollapsed: true } : {}),
            }));
            if (ev.collapseThought) ctx.hasCollapsedThought = true;
        },
        'tool-heartbeat': (ev, ctx) => {
            const names = ev.toolNames.join(', ');
            const countStr = ev.tokenCount > 0 ? `${ev.tokenCount} tokens` : `${ev.chunkCount} chunks`;
            const heartbeat = ev.isFirst
                ? `Preparing tool: ${names}…`
                : `Preparing tool: ${names}… (${countStr} received)`;
            const text = ctx.accumulatedText.trim()
                ? `${ctx.accumulatedText.trim()}\n\n${heartbeat}`
                : heartbeat;
            this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text }));
        },
    };

    /**
     * Pump the stream-event generator into the per-event handler map, then
     * apply the post-stream "collapse thought without follow-up text"
     * catch-up. Returns the generator's final result, or null if the stream
     * threw (in which case the error has already been logged).
     */
    protected async consumeStream(
        stream: AsyncIterable<AgentStreamChunk>,
        allowParallel: boolean,
        ctx: TurnContext,
    ): Promise<AgentStreamResult | null> {
        try {
            const events = processAgentStream(stream, { allowParallel });
            let next: IteratorResult<AgentStreamEvent, AgentStreamResult> = await events.next();
            while (!next.done) {
                const ev = next.value;
                (this.streamEventHandlers[ev.kind] as (e: AgentStreamEvent, c: TurnContext) => void)(ev, ctx);
                next = await events.next();
            }
            const result = next.value;
            ctx.nativeFunctionCallParts = result.nativeFunctionCallParts;

            // Stream ended with thought + no follow-up text — collapse explicitly
            // (the per-event mirror only collapses on the first text-after-thought).
            if (ctx.accumulatedThought && !ctx.hasCollapsedThought) {
                this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, isThoughtCollapsed: true }));
            }
            return result;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('Agent stream error:', e);
            this.agentLogs.update(logs => [...logs, { role: 'system', text: `Stream Error: ${msg}`, type: 'error' }]);
            this.isAgentRunning.set(false);
            return null;
        }
    }

    /**
     * Build the model turn from accumulated state + native function-call
     * parts and append it to agentHistory. Native mode preserves the
     * functionCall parts verbatim (carries thoughtSignature). JSON mode
     * keeps the raw text intact — eliding it confuses small models into
     * thinking their own write was malformed and triggers retry loops.
     */
    protected appendModelTurnToHistory(mode: 'native' | 'json', ctx: TurnContext): void {
        const modelParts: LLMPart[] = [];
        if (ctx.accumulatedThought) modelParts.push({ text: ctx.accumulatedThought, thought: true });
        if (ctx.accumulatedText) modelParts.push({ text: ctx.accumulatedText });
        if (mode === 'native') modelParts.push(...ctx.nativeFunctionCallParts);
        if (modelParts.length > 0) {
            this.agentHistory.update(h => [...h, { role: 'model', parts: modelParts }]);
        }
    }

    /**
     * JSON-mode parse failure: append model commentary to history (so retry
     * sees what the model wrote), inject a "use valid JSON" user message,
     * and recurse with retryCount+1. Bail with a logged error after 3 tries.
     */
    protected async handleJsonParseError(
        context: TContext, retryCount: number, ctx: TurnContext, turnCount = 0,
    ): Promise<void> {
        this.appendModelTurnToHistory('json', ctx);

        if (retryCount >= 3) {
            this.agentLogs.update(logs => [...logs, { role: 'system', text: 'Error parsing JSON response from model after 3 retries. Agent stopped.', type: 'error' }]);
            this.isAgentRunning.set(false);
            return;
        }
        this.agentLogs.update(logs => [...logs, { role: 'system', text: `Error parsing JSON, asking model to retry... (${retryCount + 1}/3)`, type: 'error' }]);
        this.agentHistory.update(h => [...h, {
            role: 'user',
            parts: [{ text: JSON.stringify({ error: 'Invalid JSON format. Please output ONLY valid JSON matching the schema without any markdown formatting, thought processes, or extra text.' }) }],
        }]);
        await this.processAgentTurn(context, retryCount + 1, turnCount + 1);
    }

    /**
     * Terminal action handler. Default: pre-validate, merge commentary +
     * tool message text into the streaming log entry, stop the agent.
     * Subclass overrides when terminal semantics differ (e.g. save-sim's
     * proposeDiff captures the diff to instance state).
     */
    protected async handleTerminalAction(
        context: TContext,
        terminalAction: TAction,
        mode: 'native' | 'json',
        ctx: TurnContext,
        turnCount = 0,
    ): Promise<void> {
        const validation = this.validateBeforeTerminal(terminalAction, context);
        if (!validation.valid) {
            // The contract requires errorMessage when valid is false — the LLM
            // needs SOMETHING to retry against. Fall back to a generic message
            // rather than silently treating the terminal as successful, which
            // would let a misconfigured subclass burn through to "agent stopped"
            // without telling the user / model why.
            const msg = validation.errorMessage
                ?? 'Pre-terminal validation rejected the response without supplying a reason.';
            this.appendToolResults([{ action: terminalAction, response: { status: 'acknowledged' } }], mode);
            this.agentHistory.update(h => [...h, { role: 'user', parts: [{ text: msg }] }]);
            this.agentLogs.update(logs => [...logs, { role: 'system', text: msg, type: 'info' }]);
            await this.processAgentTurn(context, 0, turnCount + 1);
            return;
        }

        const argMessage = (terminalAction as unknown as { args?: { message?: unknown } }).args?.message;
        const toolMsg = this.processToolMessageArg(argMessage);
        const finalMsg = (() => {
            if (mode === 'native') {
                const commentary = ctx.accumulatedText.trim();
                if (commentary && toolMsg.trim() && commentary !== toolMsg.trim()) {
                    return `${commentary}\n\n${toolMsg.trim()}`;
                }
                return toolMsg || ctx.accumulatedText || '(no response)';
            }
            return toolMsg || '(no response)';
        })();

        this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: finalMsg, isToolCall: false }));
        this.isAgentRunning.set(false);
    }

    /**
     * Single-action fast path: reuse the streaming log entry for the
     * tool-call display when the model produced no commentary, otherwise
     * append a fresh tool-call entry alongside the commentary. Either way,
     * execute the tool, log the result, and recurse.
     */
    protected async executeSingleAction(
        a: TAction, context: TContext, mode: 'native' | 'json', ctx: TurnContext, turnCount = 0,
    ): Promise<void> {
        if (a.action === 'reportProgress') {
            const message = this.processToolMessageArg(a.args['message']);
            this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: message, isToolCall: false }));
            this.appendToolResults([{ action: a, response: { status: 'acknowledged' } }], mode);
            await this.processAgentTurn(context, 0, turnCount + 1);
            return;
        }

        const toolEntry = this.buildToolCallLogEntry(a);
        const hasUsefulCommentary = mode === 'native' && ctx.accumulatedText.trim().length > 0;
        if (hasUsefulCommentary) {
            this.agentLogs.update(logs => [...logs, toolEntry]);
        } else {
            this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, ...toolEntry }));
        }

        const result = await this.dispatchTool(a, context);
        if (result.infoLog) {
            this.agentLogs.update(logs => [...logs, { role: 'system', text: result.infoLog!, type: 'info' }]);
        }
        this.pushToolResultLog(result.response, toolEntry.toolName);
        this.appendToolResults([{ action: a, response: result.response }], mode);
        await this.processAgentTurn(context, 0, turnCount + 1);
    }

    /**
     * Multi-action batch: append a fresh log entry per action (so each tool
     * call is visible on its own line), execute each in turn, then recurse.
     */
    protected async executeBatchActions(
        actions: TAction[], context: TContext, mode: 'native' | 'json', ctx: TurnContext, turnCount = 0,
    ): Promise<void> {
        const executed: { action: TAction; response: Record<string, unknown> }[] = [];

        const hasUsefulCommentary = mode === 'native' && ctx.accumulatedText.trim().length > 0;
        let streamingEntryAvailable = !hasUsefulCommentary;

        for (const a of actions) {
            if (a.action === 'reportProgress') {
                const message = this.processToolMessageArg(a.args['message']);
                if (streamingEntryAvailable) {
                    this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: message, isToolCall: false }));
                    streamingEntryAvailable = false;
                } else {
                    this.agentLogs.update(logs => [...logs, { role: 'model', text: message, type: 'model' as const }]);
                }
                executed.push({ action: a, response: { status: 'acknowledged' } });
                continue;
            }
            const toolEntry = this.buildToolCallLogEntry(a);
            if (streamingEntryAvailable) {
                this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, ...toolEntry }));
                streamingEntryAvailable = false;
            } else {
                this.agentLogs.update(logs => [...logs, toolEntry]);
            }
            const result = await this.dispatchTool(a, context);
            if (result.infoLog) {
                this.agentLogs.update(logs => [...logs, { role: 'system', text: result.infoLog!, type: 'info' }]);
            }
            this.pushToolResultLog(result.response, toolEntry.toolName);
            executed.push({ action: a, response: result.response });
        }

        this.appendToolResults(executed, mode);
        await this.processAgentTurn(context, 0, turnCount + 1);
    }

    /**
     * Append a single user-role message containing all tool responses from
     * this turn. Native mode emits N functionResponse parts; JSON mode is
     * single-tool-per-turn so the array is always length 1.
     */
    protected appendToolResults(
        executed: { action: { action: string; callId?: string }; response: Record<string, unknown> }[],
        mode: 'native' | 'json',
    ): void {
        if (executed.length === 0) return;
        if (mode === 'native') {
            const parts: LLMPart[] = executed.map(e => ({
                functionResponse: {
                    id: e.action.callId,
                    name: e.action.action,
                    response: e.response,
                },
            }));
            this.agentHistory.update(h => [...h, { role: 'user', parts }]);
        } else {
            this.agentHistory.update(h => [...h, {
                role: 'user',
                parts: [{ text: JSON.stringify({ result: executed[0].response }) }],
            }]);
        }
    }

    /**
     * Build the AgentLogEntry shape used to display a non-progress tool
     * call. Default toolName is just `action.action` — subclasses with
     * domain-specific argument shapes (file-agent's `filename`, save-sim's
     * `entityName`) override {@link formatToolName} to enrich the label.
     */
    protected buildToolCallLogEntry(a: TAction): AgentLogEntry & { toolName: string } {
        const args = a.args;
        const reason = ('reason' in args && typeof args.reason === 'string') ? args.reason : undefined;
        return {
            role: 'model',
            text: this.formatToolCallEntryText(a),
            type: 'model' as const,
            isToolCall: true,
            isToolCallCollapsed: true,
            toolName: this.formatToolName(a),
            reason,
        };
    }

    /**
     * How the tool name renders in the trace log header. Default just uses
     * the action verb (`readFile`); subclasses can append domain-specific
     * descriptors (`readFile(foo.md)`, `proposeDiff(李四)`) by overriding.
     */
    protected formatToolName(a: TAction): string {
        return a.action;
    }

    /** How the action body is rendered into the trace log entry's `text`. */
    protected formatToolCallEntryText(a: TAction): string {
        return JSON.stringify({ action: a.action, args: a.args });
    }

    // ===== Helper exposed for subclass setup =====

    /**
     * Build the gen-config payload for `provider.generateContentStream`
     * based on tool-call mode. Subclass calls this from `resolveTurnSetup`.
     */
    protected buildGenConfig(mode: 'native' | 'json', isLocalProvider: boolean): Record<string, unknown> {
        return mode === 'native'
            ? { tools: this.tools, signal: this.abortController?.signal }
            : { responseSchema: buildJsonSchema(this.tools, isLocalProvider), responseMimeType: 'application/json', signal: this.abortController?.signal };
    }
}

/**
 * Pure parse: native mode wraps `LLMFunctionCall[]` into action shape; JSON
 * mode tolerates surrounding noise (`/\{[\s\S]*\}/` extracts the outermost
 * JSON object) and validates the action shape. Failure path is a single
 * sentinel — caller drives the retry policy.
 */
export function parseActionsFromOutput<TAction extends ParsedAction>(
    mode: 'native' | 'json',
    accumulatedText: string,
    nativeFunctionCalls: LLMFunctionCall[],
): { ok: true; actions: TAction[] } | { ok: false } {
    if (mode === 'native') {
        const actions = nativeFunctionCalls.map(fc => ({
            action: fc.name,
            args: (fc.args ?? {}) as Record<string, unknown>,
            callId: fc.id,
        })) as unknown as TAction[];
        return { ok: true, actions };
    }
    // Explicit empty / no-object guard: an LLM response with zero `{` chars
    // is unambiguously "no tool call" — fall through to ok:[] (commentary-
    // only finish) rather than feed an unparseable raw string into JSON.parse
    // and rely on the catch to retry. Avoids burning one of the 3 retry
    // attempts on a model that just typed prose.
    const jsonMatch = accumulatedText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: true, actions: [] };
    try {
        const raw = JSON.parse(jsonMatch[0]);
        if (raw && typeof raw.action === 'string') {
            return {
                ok: true,
                actions: [{ action: raw.action, args: raw.args || {} }] as unknown as TAction[],
            };
        }
        return { ok: true, actions: [] };
    } catch {
        return { ok: false };
    }
}
