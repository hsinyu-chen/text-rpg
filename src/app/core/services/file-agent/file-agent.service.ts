import { Injectable, inject, signal, computed, resource, effect } from '@angular/core';
import { LLMConfigService } from '../llm-config.service';
import { LLMProviderRegistryService } from '../llm-provider-registry.service';
import { LLMContent, LLMPart, LLMFunctionCall } from '@hcs/llm-core';
import { FileAgentContext, AgentLogEntry, ParsedAction } from './file-agent.types';
import { FILE_AGENT_TOOLS, buildJsonSchema } from './file-agent-tools';
import { buildSystemInstruction } from './file-agent-prompts';
import { executeFileTool } from './file-agent-tool-executor';
import { WorldCompletionValidator } from './world-completion-validator';
import { sanitizeLatexToUnicode } from '@app/core/utils/latex.util';
import {
  processAgentStream, AgentStreamEvent, AgentStreamResult, AgentStreamChunk
} from './agent-stream-processor';
import { AgentCapabilityResolver } from './agent-capability-resolver';
import { KVStore } from '../kv/kv-store';
import { FileAgentSettingsStore } from './file-agent-settings.store';
import { I18nService } from '@app/core/i18n';
import { getLocale } from '@app/core/constants/locales';
import { AgentHintRegistry } from '@app/core/services/agent-hints/agent-hints.registry';
import { applyHarnessFallbacks } from './normalize-message-links.util';

// ParsedAction args come through an `as unknown` cast — runtime shape isn't
// guaranteed. Coerce non-string `message` payloads (hallucinated objects /
// null / number) to '' before piping into sanitizeLatexToUnicode +
// applyHarnessFallbacks, both of which assume string input.
function getStringArg(val: unknown): string {
  return typeof val === 'string' ? val : '';
}

/**
 * Mutable per-turn context shared across phase helpers (stream consumer,
 * history-append, dispatch). Lives on the stack inside processAgentTurn.
 */
interface TurnContext {
  currentLogIndex: number;
  accumulatedText: string;
  accumulatedThought: string;
  hasCollapsedThought: boolean;
  nativeFunctionCallParts: LLMPart[];
}

export type { FileAgentContext, ToolCallMode } from './file-agent.types';

/**
 * FileAgentService
 *
 * Manages the AI Agent's state, logs, and interaction with the LLM provider.
 *
 * Agent State Diagram:
 * ====================
 *
 * [ Idle ] (isAgentRunning = false)
 *    |
 *    | (User provides prompt)
 *    v
 * [ Generating ] <----------------------------+
 *    | (Stream finishes)                      |
 *    v                                        |
 * [ Parsing ] --- (Error) --> [ Error ]       |
 *    | (Valid tool call(s) or commentary)     |
 *    v                                        |
 * [ Executing ]                               |
 *    | (Action: reportFinish / no tool call)  |
 *    +--------------------> [ Idle ]          |
 *    |                                        |
 *    | (Action: reportProgress / file tool)   |
 *    +----------------------------------------+
 *      (Inject tool result & next turn)
 */
@Injectable()
export class FileAgentService {
  private llmConfigService = inject(LLMConfigService);
  private llmProviderRegistry = inject(LLMProviderRegistryService);
  private kv = inject(KVStore);
  private settings = inject(FileAgentSettingsStore);
  private i18n = inject(I18nService);
  private hintRegistry = inject(AgentHintRegistry);
  private completionValidator: WorldCompletionValidator | null = null;

  setCompletionValidator(v: WorldCompletionValidator): void {
    this.completionValidator = v;
  }

  agentProfiles = this.llmConfigService.profiles;
  /** Shared across all file-agent surfaces (dialog + main-screen) via FileAgentSettingsStore. */
  selectedProfileId = this.settings.selectedProfileId;
  agentLogs = signal<AgentLogEntry[]>([]);
  lastFilesReplaced = signal<{ filename: string; content: string }[]>([]);

  /**
   * Tool-call capability resolution (native vs JSON, parallel calls) and
   * the per-profile `toolCallMode` user setting. Held as a public field so
   * templates can bind directly via `agentService.capability.X`.
   */
  readonly capability = new AgentCapabilityResolver({
    selectedProfileId: this.selectedProfileId,
    agentProfiles: this.agentProfiles,
    llmProviderRegistry: this.llmProviderRegistry,
    kv: this.kv,
    probeResults: this.settings.probeResults,
    parallelProbeResults: this.settings.parallelProbeResults,
    recordProbeResult: (id, n) => this.settings.recordProbeResult(id, n),
    recordParallelProbeResult: (id, s) => this.settings.recordParallelProbeResult(id, s),
    probeInflight: this.settings.probeInflight,
    parallelProbeInflight: this.settings.parallelProbeInflight
  });

  private pushToolResultLog(response: Record<string, unknown>, toolName?: string): void {
    this.agentLogs.update(logs => [...logs, {
      role: 'system',
      text: JSON.stringify(response, null, 2),
      type: 'action' as const,
      isToolResult: true,
      isToolResultCollapsed: true,
      toolName
    }]);
  }

  /** Mutate the entry at `index` via a patch produced by `mutator`. */
  private updateLogAt(index: number, mutator: (entry: AgentLogEntry) => AgentLogEntry): void {
    this.agentLogs.update(logs => {
      const next = [...logs];
      if (next[index]) next[index] = mutator(next[index]);
      return next;
    });
  }

  /**
   * Per-event handlers for the LLM stream. Keyed by event kind so the
   * dispatch is a single lookup rather than a switch ladder; per-handler
   * state lives in the `TurnContext` passed in from processAgentTurn.
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
        ...(ev.collapseThought ? { isThoughtCollapsed: true } : {})
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
    }
  };

  isAgentRunning = signal(false);
  agentHistory = signal<LLMContent[]>([]);
  /** Live prefill / prompt-processing progress (0..1) for providers that report it (e.g. llama.cpp). undefined when unknown or finished. */
  promptProgress = signal<number | undefined>(undefined);
  /** Live accumulated output token count. */
  generatedTokenCount = signal<number>(0);
  generatedChunkCount = signal<number>(0);
  private abortController: AbortController | null = null;

  constructor() {
    // React to shared selectedProfileId changes (this instance's user picks
    // a profile in its UI, OR a sibling instance does and the shared signal
    // propagates). Two responsibilities:
    //  (a) kick the tool-support probe for the new profile,
    //  (b) reload this instance's toolCallMode signal from KV — without this,
    //      a sibling-driven profile switch would leave our resolver pointing
    //      at the previous profile's mode setting.
    // Listening to both signals also handles two startup races: selectedProfileId
    // resolving before the profile list loads from IndexedDB, and the
    // post-save profile-list reload.
    let lastSynced = '';
    effect(() => {
      const id = this.selectedProfileId();
      const list = this.agentProfiles();
      if (!id || lastSynced === id) return;
      if (!list.find(p => p.id === id)) return;
      lastSynced = id;
      this.capability.syncToolCallModeForProfile(id);
      void this.capability.kickToolSupportProbe(id);
    });
  }

  agentContextInfo = resource({
    params: () => ({ history: this.agentHistory(), profileId: this.selectedProfileId() }),
    loader: async ({ params }) => {
      const { history, profileId } = params;
      if (!profileId) return { used: 0, size: null };

      const profile = this.agentProfiles().find(p => p.id === profileId);
      if (!profile) return { used: 0, size: null };

      const provider = this.llmProviderRegistry.getProvider(profile.provider);
      if (!provider) return { used: 0, size: null };

      let size: number | null = null;
      const modelId = profile.settings.modelId || provider.getDefaultModelId();
      try {
        const models = await Promise.resolve(provider.getAvailableModels(profile.settings));
        const model = models.find(m => m.id === modelId);
        if (model?.contextSize) size = model.contextSize;
      } catch (e) {
        console.warn("Failed to fetch models for context size", e);
      }

      let used = 0;
      if (history.length > 0) {
        try {
          const sysPrompt = `You are a helpful file editing assistant inside a code editor dialog.`;
          used = await provider.countTokens(profile.settings, modelId, [
            { role: 'user', parts: [{ text: sysPrompt }] },
            ...history
          ]);
        } catch (e) {
          console.warn("Failed to count tokens", e);
        }
      }

      return { used, size };
    }
  });

  agentContextUsed = computed(() => this.agentContextInfo.value()?.used || 0);
  agentContextSize = computed(() => this.agentContextInfo.value()?.size || null);
  agentContextPercent = computed(() => {
    const used = this.agentContextUsed();
    const size = this.agentContextSize();
    if (!size || size <= 0) return 0;
    return Math.min(100, (used / size) * 100);
  });
  agentContextLevel = computed(() => {
    const pct = this.agentContextPercent();
    if (pct >= 95) return 'critical';
    if (pct >= 80) return 'high';
    if (pct >= 60) return 'warning';
    return 'safe';
  });

  selectProfile(profileId: string): void {
    this.settings.selectProfile(profileId);
    this.capability.syncToolCallModeForProfile(profileId);
  }

  clearHistory(): void {
    if (this.isAgentRunning()) return;
    this.agentHistory.set([]);
    this.agentLogs.set([]);
  }

  async runAgent(prompt: string, context: FileAgentContext): Promise<void> {
    if (!prompt || this.isAgentRunning()) return;

    const profileId = this.selectedProfileId();
    if (!profileId) {
      this.agentLogs.update(logs => [...logs, { role: 'system', text: 'No LLM profile selected.', type: 'error' }]);
      return;
    }

    this.abortController = new AbortController();
    this.isAgentRunning.set(true);
    this.generatedTokenCount.set(0);
    this.agentLogs.update(logs => [...logs, { role: 'user', text: prompt, type: 'info' }]);

    // Tag the prompt with the current surface mode (editor / readonly) so
    // the LLM perceives editor↔readonly transitions across turns without us
    // having to rebuild the system prompt (which would invalidate the KV
    // cache). The system prompt's "EDITING SURFACE — TWO MODES" block tells
    // the LLM how to read the marker; runtime gating still lives on
    // `context.readOnly` enforced by the tool executor. Only the history /
    // LLM-bound copy carries the tag — agentLogs above shows the user's
    // original text.
    const tag = `[mode: ${context.readOnly ? 'readonly' : 'editor'}]\n`;
    const newHistory = [...this.agentHistory(), { role: 'user' as const, parts: [{ text: tag + prompt }] }];
    this.agentHistory.set(newHistory);

    // Augment context with the uiMap callback so the executor stays
    // DI-free. Caller-supplied uiMap (if any) wins — useful for tests.
    const augmentedContext: FileAgentContext = {
      ...context,
      uiMap: context.uiMap ?? (() => this.hintRegistry.buildUiMap()),
    };

    try {
      await this.processAgentTurn(augmentedContext);
    } catch (err) {
      if (this.abortController?.signal.aborted) {
        this.agentLogs.update(logs => [...logs, { role: 'system', text: 'Agent stopped by user.', type: 'info' }]);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.agentLogs.update(logs => [...logs, { role: 'system', text: `Error: ${msg}`, type: 'error' }]);
      }
      this.isAgentRunning.set(false);
    } finally {
      this.abortController = null;
    }
  }

  stopAgent(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.isAgentRunning.set(false);
    this.promptProgress.set(undefined);
  }

  private resolveToolCallMode(): 'native' | 'json' {
    return this.capability.effectiveToolCallModeIsNative() ? 'native' : 'json';
  }

  /**
   * Orchestrator: setup → stream consume → parse → dispatch. Phase
   * helpers (handleJsonParseError, handleSubmitResponse, executeSingleAction,
   * executeBatchActions) re-enter via processAgentTurn for retries, validator
   * rejection, reportProgress, and tool-call follow-up turns.
   */
  private async processAgentTurn(context: FileAgentContext, retryCount = 0): Promise<void> {
    const setup = this.setupTurn(context);
    if (!setup) return;
    const { profile, provider, mode, allowParallel, genConfig } = setup;

    const ctx = this.openTurnLogEntry();
    const stream = provider.generateContentStream(profile.settings, this.agentHistory(), setup.systemInstruction, genConfig);

    const result = await this.consumeStream(stream, allowParallel, ctx);
    if (!result) return;

    if (mode === 'native' && ctx.accumulatedText) {
      ctx.accumulatedText = applyHarnessFallbacks(sanitizeLatexToUnicode(ctx.accumulatedText), this.harnessLabels());
      this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: ctx.accumulatedText }));
    }

    const parsed = parseActionsFromOutput(mode, ctx.accumulatedText, result.nativeFunctionCalls);
    if (!parsed.ok) {
      await this.handleJsonParseError(context, retryCount, ctx);
      return;
    }

    this.appendModelTurnToHistory(mode, ctx);

    if (parsed.actions.length === 0) {
      // Commentary-only output: implicit finish.
      this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: ctx.accumulatedText || '(no response)' }));
      this.isAgentRunning.set(false);
      return;
    }

    // submitResponse anywhere in the batch ends the turn (after validator).
    const finishCall = parsed.actions.find(
      (a: ParsedAction): a is Extract<ParsedAction, { action: 'submitResponse' }> =>
        a.action === 'submitResponse'
    );
    if (finishCall) {
      await this.handleSubmitResponse(context, finishCall, mode, ctx);
      return;
    }

    if (parsed.actions.length === 1) {
      await this.executeSingleAction(parsed.actions[0], context, mode, ctx);
    } else {
      await this.executeBatchActions(parsed.actions, context, mode);
    }
  }

  /**
   * Resolve profile + provider + tool-call mode + system prompt + gen
   * config for this turn. Returns null on a missing profile id (caller
   * silently bails — the runAgent guard already logged the user-facing
   * "no profile selected" message).
   */
  private setupTurn(context: FileAgentContext): {
    profile: ReturnType<FileAgentService['agentProfiles']>[number];
    provider: NonNullable<ReturnType<LLMProviderRegistryService['getProvider']>>;
    mode: 'native' | 'json';
    allowParallel: boolean;
    systemInstruction: string;
    genConfig: Record<string, unknown>;
  } | null {
    const profileId = this.selectedProfileId();
    if (!profileId) return null;

    const profile = this.agentProfiles().find(p => p.id === profileId);
    if (!profile) throw new Error('Profile not found');

    const provider = this.llmProviderRegistry.getProvider(profile.provider);
    if (!provider) throw new Error('Provider not found');

    const cap = provider.getCapabilities(profile.settings);
    const mode = this.resolveToolCallMode();

    // File list is filenames-only (no per-file line counts) so the system
    // prompt stays stable across turns within a session — content edits
    // would otherwise invalidate prompt prefix caches (Gemini implicit cache,
    // llama.cpp KV slot prefix match) on every replaceFile/replaceSection.
    // Fresh totalLines is returned in every read/write tool response instead.
    const fileList = Array.from(context.files.keys()).map(name => `- ${name}`).join('\n');
    const allowParallel = mode === 'native' && this.capability.effectiveSupportsParallelToolCalls();
    const locale = getLocale(context.narrativeLanguage);
    const systemInstruction = buildSystemInstruction(
      fileList,
      mode,
      allowParallel,
      {
        uiLanguage: context.uiLanguage,
        narrativeLanguage: context.narrativeLanguage,
      },
      locale,
      (key: string) => this.i18n.translate(key)
    );

    const genConfig: Record<string, unknown> = mode === 'native'
      ? { tools: FILE_AGENT_TOOLS, signal: this.abortController?.signal }
      : { responseSchema: buildJsonSchema(cap.isLocalProvider), responseMimeType: 'application/json', signal: this.abortController?.signal };

    // Reset progress signals for this turn before the stream lands.
    this.generatedTokenCount.set(0);
    this.generatedChunkCount.set(0);
    this.promptProgress.set(undefined);

    return { profile, provider, mode, allowParallel, systemInstruction, genConfig };
  }

  /** Append a fresh streaming model entry; return the per-turn context. */
  private harnessLabels(): { messageLink: string } {
    return { messageLink: this.i18n.translate('dialog.agentHarnessMessageLink') };
  }

  /** Single processing pipeline for any user-visible message tool-arg
   *  (submitResponse.message / reportProgress.message): coerce non-string
   *  hallucinations to '', then LaTeX-sanitize + run harness fallbacks
   *  (code-unwrap / empty-label backfill / relabel ugly / GUID auto-link /
   *  adjacent-dup collapse). `labels` is exposed so batch callers can hoist
   *  the i18n lookup outside their loop. */
  private processAgentMessage(rawArg: unknown, labels: { messageLink: string } = this.harnessLabels()): string {
    return applyHarnessFallbacks(sanitizeLatexToUnicode(getStringArg(rawArg)), labels);
  }

  private openTurnLogEntry(): TurnContext {
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
      nativeFunctionCallParts: []
    };
  }

  /**
   * Pump the stream-event generator into the per-event handler map, then
   * apply the post-stream "collapse thought without follow-up text"
   * catch-up. Returns the generator's final result, or null if the stream
   * threw (in which case the error has already been logged).
   */
  private async consumeStream(
    stream: AsyncIterable<AgentStreamChunk>,
    allowParallel: boolean,
    ctx: TurnContext
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
  private appendModelTurnToHistory(mode: 'native' | 'json', ctx: TurnContext): void {
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
  private async handleJsonParseError(
    context: FileAgentContext, retryCount: number, ctx: TurnContext
  ): Promise<void> {
    // Persist what the model wrote so the retry sees its own output. JSON
    // mode has no native function-call parts, so this delegates cleanly.
    this.appendModelTurnToHistory('json', ctx);

    if (retryCount >= 3) {
      this.agentLogs.update(logs => [...logs, { role: 'system', text: 'Error parsing JSON response from model after 3 retries. Agent stopped.', type: 'error' }]);
      this.isAgentRunning.set(false);
      return;
    }
    this.agentLogs.update(logs => [...logs, { role: 'system', text: `Error parsing JSON, asking model to retry... (${retryCount + 1}/3)`, type: 'error' }]);
    this.agentHistory.update(h => [...h, {
      role: 'user',
      parts: [{ text: JSON.stringify({ error: 'Invalid JSON format. Please output ONLY valid JSON matching the schema without any markdown formatting, thought processes, or extra text.' }) }]
    }]);
    await this.processAgentTurn(context, retryCount + 1);
  }

  /**
   * submitResponse path: validate completion (recurse on rejection,
   * carrying the validator's reason as a follow-up user message), then
   * merge commentary + tool message into the streaming log entry and
   * stop the agent.
   */
  private async handleSubmitResponse(
    context: FileAgentContext,
    finishCall: Extract<ParsedAction, { action: 'submitResponse' }>,
    mode: 'native' | 'json',
    ctx: TurnContext
  ): Promise<void> {
    if (this.completionValidator && !this.completionValidator.isCompleted) {
      const validation = this.completionValidator.validate();
      if (!validation.valid) {
        this.appendToolResults([{ action: finishCall, response: { status: 'acknowledged' } }], mode);
        this.agentHistory.update(h => [...h, { role: 'user', parts: [{ text: validation.errorMessage }] }]);
        this.agentLogs.update(logs => [...logs, { role: 'system', text: validation.errorMessage, type: 'info' }]);
        await this.processAgentTurn(context);
        return;
      }
    }

    // Process toolMsg through sanitize + normalize here; in native mode
    // ctx.accumulatedText was already processed at processAgentTurn line ~340,
    // so we don't re-run those on the merged result.
    const toolMsg = this.processAgentMessage(finishCall.args.message);
    // In native mode, accumulatedText is genuine commentary that lives
    // alongside the structured function call — merge with toolMsg when both
    // are present and distinct. In JSON mode, accumulatedText IS the raw
    // JSON tool-call body (the model's entire response), so showing it
    // duplicates the parsed toolMsg verbatim; only render the parsed
    // message.
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
  private async executeSingleAction(
    a: ParsedAction, context: FileAgentContext, mode: 'native' | 'json', ctx: TurnContext
  ): Promise<void> {
    if (a.action === 'reportProgress') {
      const message = this.processAgentMessage(a.args.message);
      this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: message, isToolCall: false }));
      this.appendToolResults([{ action: a, response: { status: 'acknowledged' } }], mode);
      await this.processAgentTurn(context);
      return;
    }

    const toolEntry = buildToolCallLogEntry(a);
    // In JSON mode `accumulatedText` IS the raw JSON tool-call body — not
    // real commentary — so splitting into two log entries produced visually
    // identical "MODEL" + "MODEL [TOOL CALL]" pairs in copyDebugLog. Only
    // treat accumulatedText as commentary when we're in native mode, where
    // function calls travel as structured parts and any text alongside is
    // genuine narration.
    const hasUsefulCommentary = mode === 'native' && ctx.accumulatedText.trim().length > 0;
    if (hasUsefulCommentary) {
      // Commentary present: leave it in the current entry, append a new one.
      this.agentLogs.update(logs => [...logs, toolEntry]);
    } else {
      // No commentary (or JSON mode where the text is the JSON itself):
      // overwrite the streaming entry with the parsed tool-call view.
      this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, ...toolEntry }));
    }

    let singleReplaced: { filename: string; content: string } | null = null;
    const singleContext: FileAgentContext = {
      ...context,
      onFileReplaced: (f, c) => { context.onFileReplaced(f, c); singleReplaced = { filename: f, content: c }; }
    };
    const result = executeFileTool(a, singleContext);
    if (singleReplaced) this.lastFilesReplaced.set([singleReplaced]);
    if (result.infoLog) {
      this.agentLogs.update(logs => [...logs, { role: 'system', text: result.infoLog!, type: 'info' }]);
    }
    this.pushToolResultLog(result.response, toolEntry.toolName);
    this.appendToolResults([{ action: a, response: result.response }], mode);
    await this.processAgentTurn(context);
  }

  /**
   * Multi-action batch: append a fresh log entry per action (so each tool
   * call is visible on its own line), execute each in turn against a
   * shared replacements collector, then recurse. lastFilesReplaced is set
   * once at end — Angular signal batching would otherwise lose
   * intermediate updates inside the synchronous loop.
   */
  private async executeBatchActions(
    actions: ParsedAction[], context: FileAgentContext, mode: 'native' | 'json'
  ): Promise<void> {
    const executed: { action: ParsedAction; response: Record<string, unknown> }[] = [];
    const batchReplacements: { filename: string; content: string }[] = [];
    const batchContext: FileAgentContext = {
      ...context,
      onFileReplaced: (f, c) => { context.onFileReplaced(f, c); batchReplacements.push({ filename: f, content: c }); }
    };
    // Hoist out of the loop: harnessLabels() does an i18n lookup; the result
    // is stable for the batch, so resolve once and reuse.
    const labels = this.harnessLabels();

    for (const a of actions) {
      if (a.action === 'reportProgress') {
        const message = this.processAgentMessage(a.args.message, labels);
        this.agentLogs.update(logs => [...logs, { role: 'model', text: message, type: 'model' as const }]);
        executed.push({ action: a, response: { status: 'acknowledged' } });
        continue;
      }
      const toolEntry = buildToolCallLogEntry(a);
      this.agentLogs.update(logs => [...logs, toolEntry]);
      const result = executeFileTool(a, batchContext);
      if (result.infoLog) {
        this.agentLogs.update(logs => [...logs, { role: 'system', text: result.infoLog!, type: 'info' }]);
      }
      this.pushToolResultLog(result.response, toolEntry.toolName);
      executed.push({ action: a, response: result.response });
    }

    if (batchReplacements.length > 0) this.lastFilesReplaced.set(batchReplacements);
    this.appendToolResults(executed, mode);
    await this.processAgentTurn(context);
  }

  /**
   * Append a single user-role message containing all tool responses from this
   * turn. Native mode emits N functionResponse parts (one per tool call) so
   * the model receives them as a batched reply, saving N-1 round-trips.
   * JSON mode is single-tool-per-turn, so the array is always length 1.
   */
  private appendToolResults(
    executed: { action: { action: string, callId?: string }, response: Record<string, unknown> }[],
    mode: 'native' | 'json'
  ): void {
    if (executed.length === 0) return;
    if (mode === 'native') {
      const parts: LLMPart[] = executed.map(e => ({
        functionResponse: {
          id: e.action.callId,
          name: e.action.action,
          response: e.response
        }
      }));
      this.agentHistory.update(h => [...h, { role: 'user', parts }]);
    } else {
      this.agentHistory.update(h => [...h, {
        role: 'user',
        parts: [{ text: JSON.stringify({ result: executed[0].response }) }]
      }]);
    }
  }
}

// ===== Module-level helpers =================================================

/**
 * Pure parse: native mode wraps `LLMFunctionCall[]` into `ParsedAction[]`;
 * JSON mode tolerates surrounding noise (`/\{[\s\S]*\}/` extracts the
 * outermost JSON object) and validates the action shape. Failure path is
 * a single sentinel — caller drives the retry policy.
 */
function parseActionsFromOutput(
  mode: 'native' | 'json',
  accumulatedText: string,
  nativeFunctionCalls: LLMFunctionCall[]
): { ok: true; actions: ParsedAction[] } | { ok: false } {
  if (mode === 'native') {
    const actions = nativeFunctionCalls.map(fc => ({
      action: fc.name,
      args: (fc.args ?? {}) as Record<string, unknown>,
      callId: fc.id
    })) as unknown as ParsedAction[];
    return { ok: true, actions };
  }
  try {
    let jsonString = accumulatedText;
    const jsonMatch = accumulatedText.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonString = jsonMatch[0];
    const raw = JSON.parse(jsonString);
    if (raw && typeof raw.action === 'string') {
      return {
        ok: true,
        actions: [{ action: raw.action, args: raw.args || {} }] as unknown as ParsedAction[]
      };
    }
    return { ok: true, actions: [] };
  } catch {
    return { ok: false };
  }
}

/**
 * Build the AgentLogEntry shape used to display a non-progress tool call.
 * Same shape whether the entry overwrites the streaming row (single-action
 * fast path with no commentary) or is appended (commentary or batch).
 */
function buildToolCallLogEntry(a: ParsedAction): AgentLogEntry & { toolName: string } {
  const args = a.args as unknown as Record<string, unknown>;
  const filename = (typeof args['filename'] === 'string') ? args['filename'] : '';
  const toolName = `${a.action}(${filename})`;
  const reason = (typeof args['reason'] === 'string') ? args['reason'] : undefined;
  return {
    role: 'model',
    text: JSON.stringify({ action: a.action, args: a.args }, null, 2),
    type: 'model' as const,
    isToolCall: true,
    isToolCallCollapsed: true,
    toolName,
    reason
  };
}
