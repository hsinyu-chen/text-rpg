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
import { processAgentStream, AgentStreamEvent, AgentStreamResult } from './agent-stream-processor';
import { AgentCapabilityResolver } from './agent-capability-resolver';

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
  private completionValidator: WorldCompletionValidator | null = null;

  setCompletionValidator(v: WorldCompletionValidator): void {
    this.completionValidator = v;
  }

  agentProfiles = this.llmConfigService.profiles;
  selectedProfileId = signal<string | null>(this.llmConfigService.activeProfileId());
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
    llmProviderRegistry: this.llmProviderRegistry
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

  isAgentRunning = signal(false);
  agentHistory = signal<LLMContent[]>([]);
  /** Live prefill / prompt-processing progress (0..1) for providers that report it (e.g. llama.cpp). undefined when unknown or finished. */
  promptProgress = signal<number | undefined>(undefined);
  /** Live accumulated output token count. */
  generatedTokenCount = signal<number>(0);
  generatedChunkCount = signal<number>(0);
  private abortController: AbortController | null = null;

  constructor() {
    // Kick a tool-support probe whenever the selected profile resolves to a
    // populated profile object. Listening to both signals handles two
    // initialization races: (a) selectedProfileId is set before the profile
    // list has loaded from IndexedDB, and (b) the profile list reload that
    // follows a save in the settings UI.
    let lastProbed = '';
    effect(() => {
      const id = this.selectedProfileId();
      const list = this.agentProfiles();
      if (!id || lastProbed === id) return;
      if (!list.find(p => p.id === id)) return;
      lastProbed = id;
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
    this.selectedProfileId.set(profileId);
    this.capability.syncToolCallModeForProfile(profileId);
    void this.capability.kickToolSupportProbe(profileId);
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

    const newHistory = [...this.agentHistory(), { role: 'user' as const, parts: [{ text: prompt }] }];
    this.agentHistory.set(newHistory);

    try {
      await this.processAgentTurn(context);
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

  private async processAgentTurn(context: FileAgentContext, retryCount = 0): Promise<void> {
    const profileId = this.selectedProfileId();
    if (!profileId) return;

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
    const systemInstruction = buildSystemInstruction(fileList, mode, allowParallel);

    const genConfig = mode === 'native'
      ? { tools: FILE_AGENT_TOOLS, signal: this.abortController?.signal }
      : { responseSchema: buildJsonSchema(cap.isLocalProvider), responseMimeType: 'application/json', signal: this.abortController?.signal };

    // Reset progress tracking for this specific turn
    this.generatedTokenCount.set(0);
    this.generatedChunkCount.set(0);
    this.promptProgress.set(undefined);

    let currentLogIndex = -1;
    this.agentLogs.update(logs => {
      const newLogs = [...logs, { role: 'model', text: '', type: 'model' as const, isThoughtCollapsed: false }];
      currentLogIndex = newLogs.length - 1;
      return newLogs;
    });

    const stream = provider.generateContentStream(
      profile.settings,
      this.agentHistory(),
      systemInstruction,
      genConfig
    );

    let accumulatedText = '';
    let accumulatedThought = '';
    let hasCollapsedThought = false;
    let nativeFunctionCalls: LLMFunctionCall[] = [];
    let nativeFunctionCallParts: LLMPart[] = [];

    this.promptProgress.set(undefined);

    try {
      const events = processAgentStream(stream, { allowParallel });
      let next: IteratorResult<AgentStreamEvent, AgentStreamResult> = await events.next();
      while (!next.done) {
        const ev = next.value;
        switch (ev.kind) {
          case 'progress':
            this.generatedChunkCount.set(ev.chunkCount);
            if (ev.tokenCount !== undefined) this.generatedTokenCount.set(ev.tokenCount);
            if (ev.promptProgress !== undefined) this.promptProgress.set(ev.promptProgress);
            // When promptProgress AND text/functionCall arrive in the same
            // chunk, the clear wins — keeps the prompt bar from lingering
            // during tool-call streaming on throttled-heartbeat chunks.
            if (ev.clearPromptProgress) this.promptProgress.set(undefined);
            break;
          case 'thought':
            accumulatedThought = ev.accumulatedThought;
            this.agentLogs.update(logs => {
              const out = [...logs];
              if (out[currentLogIndex]) {
                out[currentLogIndex] = { ...out[currentLogIndex], thought: accumulatedThought };
              }
              return out;
            });
            break;
          case 'text':
            accumulatedText = ev.accumulatedText;
            this.agentLogs.update(logs => {
              const out = [...logs];
              if (out[currentLogIndex]) {
                const entry = { ...out[currentLogIndex], text: accumulatedText };
                if (ev.collapseThought) entry.isThoughtCollapsed = true;
                out[currentLogIndex] = entry;
              }
              return out;
            });
            if (ev.collapseThought) hasCollapsedThought = true;
            break;
          case 'tool-heartbeat': {
            const names = ev.toolNames.join(', ');
            const countStr = ev.tokenCount > 0
              ? `${ev.tokenCount} tokens`
              : `${ev.chunkCount} chunks`;
            const heartbeat = ev.isFirst
              ? `Preparing tool: ${names}…`
              : `Preparing tool: ${names}… (${countStr} received)`;
            this.agentLogs.update(logs => {
              const out = [...logs];
              if (out[currentLogIndex]) {
                const text = accumulatedText.trim()
                  ? `${accumulatedText.trim()}\n\n${heartbeat}`
                  : heartbeat;
                out[currentLogIndex] = { ...out[currentLogIndex], text };
              }
              return out;
            });
            break;
          }
        }
        next = await events.next();
      }

      // accumulatedText / accumulatedThought / hasCollapsedThought are
      // already in sync via the per-event mirror above; only the tool-call
      // arrays need pulling from the generator's return value.
      const result = next.value;
      nativeFunctionCalls = result.nativeFunctionCalls;
      nativeFunctionCallParts = result.nativeFunctionCallParts;

      if (accumulatedThought && !hasCollapsedThought) {
        this.agentLogs.update(logs => {
          const out = [...logs];
          if (out[currentLogIndex]) {
            out[currentLogIndex] = { ...out[currentLogIndex], isThoughtCollapsed: true };
          }
          return out;
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Agent stream error:', e);
      this.agentLogs.update(logs => [...logs, { role: 'system', text: `Stream Error: ${msg}`, type: 'error' }]);
      this.isAgentRunning.set(false);
      return;
    }

    if (mode === 'native' && accumulatedText) {
      accumulatedText = sanitizeLatexToUnicode(accumulatedText);
      this.agentLogs.update(logs => {
        const next = [...logs];
        if (next[currentLogIndex]) {
          next[currentLogIndex] = { ...next[currentLogIndex], text: accumulatedText };
        }
        return next;
      });
    }

    let parsedActions: ParsedAction[] = [];

    if (mode === 'native') {
      parsedActions = nativeFunctionCalls.map(fc => ({
        action: fc.name,
        args: (fc.args ?? {}) as Record<string, unknown>,
        callId: fc.id
      })) as unknown as ParsedAction[];
    } else {
      try {
        let jsonString = accumulatedText;
        const jsonMatch = accumulatedText.match(/\{[\s\S]*\}/);
        if (jsonMatch) jsonString = jsonMatch[0];
        const raw = JSON.parse(jsonString);
        if (raw && typeof raw.action === 'string') {
          parsedActions = [{ action: raw.action, args: raw.args || {} }] as unknown as ParsedAction[];
        }
      } catch {
        const modelParts: LLMPart[] = [];
        if (accumulatedThought) modelParts.push({ text: accumulatedThought, thought: true });
        if (accumulatedText) modelParts.push({ text: accumulatedText });
        if (modelParts.length > 0) {
          this.agentHistory.update(h => [...h, { role: 'model', parts: modelParts }]);
        }

        if (retryCount >= 3) {
          this.agentLogs.update(logs => [...logs, { role: 'system', text: 'Error parsing JSON response from model after 3 retries. Agent stopped.', type: 'error' }]);
          this.isAgentRunning.set(false);
          return;
        }
        this.agentLogs.update(logs => [...logs, { role: 'system', text: `Error parsing JSON, asking model to retry... (${retryCount + 1}/3)`, type: 'error' }]);
        this.agentHistory.update(h => [...h, {
          role: 'user',
          parts: [{ text: JSON.stringify({ error: "Invalid JSON format. Please output ONLY valid JSON matching the schema without any markdown formatting, thought processes, or extra text." }) }]
        }]);
        await this.processAgentTurn(context, retryCount + 1);
        return;
      }
    }

    // Build & append the model turn to history.
    const modelParts: LLMPart[] = [];
    if (accumulatedThought) modelParts.push({ text: accumulatedThought, thought: true });

    if (mode === 'native') {
      if (accumulatedText) modelParts.push({ text: accumulatedText });
      // Use nativeFunctionCallParts directly to preserve all stream metadata (e.g. thoughtSignature)
      modelParts.push(...nativeFunctionCallParts);
    } else {
      // JSON mode is single-tool by design. Keep the model's raw text
      // (which contains the full content) intact in history — eliding it
      // confuses small models into believing their own write was malformed
      // and triggers retry loops.
      if (accumulatedText) modelParts.push({ text: accumulatedText });
    }

    if (modelParts.length > 0) {
      this.agentHistory.update(h => [...h, { role: 'model', parts: modelParts }]);
    }

    if (parsedActions.length === 0) {
      // Model produced only commentary text. Treat as implicit finish.
      this.agentLogs.update(logs => {
        const next = [...logs];
        if (next[currentLogIndex]) {
          next[currentLogIndex] = { ...next[currentLogIndex], text: accumulatedText || '(no response)' };
        }
        return next;
      });
      this.isAgentRunning.set(false);
      return;
    }

    // If submitResponse appears anywhere in the batch, treat the turn as done.
    const finishCall = parsedActions.find(a => a.action === 'submitResponse');
    if (finishCall) {
      // Run completion validator before allowing the agent to stop.
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

      const toolMsg = (finishCall.args['message'] as string) || '';
      // Merge commentary and tool message if they are different and both exist
      const finalMsg = (accumulatedText.trim() && toolMsg.trim() && accumulatedText.trim() !== toolMsg.trim())
        ? `${accumulatedText.trim()}\n\n${toolMsg.trim()}`
        : (toolMsg || accumulatedText || '(no response)');

      this.agentLogs.update(logs => {
        const next = [...logs];
        if (next[currentLogIndex]) {
          next[currentLogIndex] = { ...next[currentLogIndex], text: finalMsg, isToolCall: false };
        }
        return next;
      });
      this.isAgentRunning.set(false);
      return;
    }

    // Single-action fast path preserves the original UX (reuse the streaming
    // log entry for the tool-call display) so simple flows look unchanged.
    if (parsedActions.length === 1) {
      const a = parsedActions[0];

      if (a.action === 'reportProgress') {
        const message = a.args.message || '';
        this.agentLogs.update(logs => {
          const next = [...logs];
          if (next[currentLogIndex]) {
            next[currentLogIndex] = { ...next[currentLogIndex], text: message, isToolCall: false };
          }
          return next;
        });
        this.appendToolResults([{ action: a, response: { status: 'acknowledged' } }], mode);
        await this.processAgentTurn(context);
        return;
      }

      const reason = ('reason' in a.args && typeof a.args.reason === 'string') ? a.args.reason : undefined;
      if (accumulatedText.trim()) {
        const filename = ('filename' in a.args) ? a.args.filename : '';
        const toolName = `${a.action}(${filename})`;
        // If there's commentary, leave it in the current entry and append a new one for the tool
        this.agentLogs.update(logs => [
          ...logs,
          {
            role: 'model',
            text: JSON.stringify({ action: a.action, args: a.args }, null, 2),
            type: 'model' as const,
            isToolCall: true,
            isToolCallCollapsed: true,
            toolName,
            reason
          }
        ]);
      } else {
        // No commentary, overwrite the current (likely empty) entry
        this.agentLogs.update(logs => {
          const next = [...logs];
          if (next[currentLogIndex]) {
            const filename = ('filename' in a.args) ? a.args.filename : '';
            const toolName = `${a.action}(${filename})`;
            next[currentLogIndex] = {
              ...next[currentLogIndex],
              text: JSON.stringify({ action: a.action, args: a.args }, null, 2),
              isToolCall: true,
              isToolCallCollapsed: true,
              toolName,
              reason
            };
          }
          return next;
        });
      }

      const filename = ('filename' in a.args) ? a.args.filename : '';
      const toolName = `${a.action}(${filename})`;
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
      this.pushToolResultLog(result.response, toolName);
      this.appendToolResults([{ action: a, response: result.response }], mode);
      await this.processAgentTurn(context);
      return;
    }

    // Multi-action batch: leave the streaming log entry showing only commentary
    // (or empty) and append a fresh log entry per action so each tool call is
    // visible on its own line.
    const executed: { action: ParsedAction, response: Record<string, unknown> }[] = [];
    const batchReplacements: { filename: string; content: string }[] = [];
    const batchContext: FileAgentContext = {
      ...context,
      onFileReplaced: (f, c) => { context.onFileReplaced(f, c); batchReplacements.push({ filename: f, content: c }); }
    };

    for (const a of parsedActions) {
      if (a.action === 'reportProgress') {
        const message = a.args.message || '';
        this.agentLogs.update(logs => [...logs, { role: 'model', text: message, type: 'model' as const }]);
        executed.push({ action: a, response: { status: 'acknowledged' } });
        continue;
      }
      const filename = ('filename' in a.args) ? a.args.filename : '';
      const toolName = `${a.action}(${filename})`;
      const reason = ('reason' in a.args && typeof a.args.reason === 'string') ? a.args.reason : undefined;
      this.agentLogs.update(logs => [
        ...logs,
        {
          role: 'model',
          text: JSON.stringify({ action: a.action, args: a.args }, null, 2),
          type: 'model' as const,
          isToolCall: true,
          isToolCallCollapsed: true,
          toolName,
          reason
        }
      ]);
      const result = executeFileTool(a, batchContext);
      if (result.infoLog) {
        this.agentLogs.update(logs => [...logs, { role: 'system', text: result.infoLog!, type: 'info' }]);
      }
      this.pushToolResultLog(result.response, toolName);
      executed.push({ action: a, response: result.response });
    }

    // Signal all replacements from this batch at once — avoids Angular signal
    // glitch-free batching from losing intermediate updates in a synchronous loop.
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
