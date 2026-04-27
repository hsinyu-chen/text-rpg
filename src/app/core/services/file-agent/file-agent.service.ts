import { Injectable, inject, signal, computed, resource, effect } from '@angular/core';
import { LLMConfigService } from '../llm-config.service';
import { LLMProviderRegistryService } from '../llm-provider-registry.service';
import { LLMContent, LLMPart, LLMFunctionCall } from '@hcs/llm-core';
import { FileAgentContext, ToolCallMode, AgentLogEntry, ParsedAction } from './file-agent.types';
import { FILE_AGENT_TOOLS, buildJsonSchema } from './file-agent-tools';
import { buildSystemInstruction } from './file-agent-prompts';
import { executeFileTool } from './file-agent-tool-executor';
import { WorldCompletionValidator } from './world-completion-validator';
import { sanitizeLatexToUnicode } from '../../utils/latex.util';

export type { FileAgentContext, ToolCallMode } from './file-agent.types';

const TOOL_CALL_MODE_KEY_PREFIX = 'file_agent_tool_call_mode:';

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

  toolCallMode = signal<ToolCallMode>(this.loadToolCallMode(this.llmConfigService.activeProfileId()));

  /**
   * Per-profile native-tool probe results. Set after a successful async
   * probe (currently llama.cpp `/props` chat_template inspection).
   * null/missing = not probed yet or probe failed → fall through to static
   * capability.
   */
  private probeResults = signal<Record<string, boolean>>({});

  /** Per-profile parallel-tool probe results, same contract as probeResults. */
  private parallelProbeResults = signal<Record<string, boolean>>({});

  /** True when the selected profile is allowed to issue multiple tool calls per turn. */
  effectiveSupportsParallelToolCalls = computed<boolean>(() => {
    if (!this.effectiveToolCallModeIsNative()) return false;
    const id = this.selectedProfileId();
    const profile = id ? this.agentProfiles().find(p => p.id === id) : null;
    if (!profile || !id) return false;

    const explicit = profile.settings.additionalSettings?.['supportsParallelToolCalls'];
    if (typeof explicit === 'boolean') return explicit;

    const probed = this.parallelProbeResults()[id];
    if (typeof probed === 'boolean') return probed;

    const cap = this.llmProviderRegistry.getProvider(profile.provider)?.getCapabilities(profile.settings);
    return !!cap?.supportsParallelToolCalls;
  });

  /** True when 'auto' would resolve to native for the selected profile. */
  effectiveToolCallModeIsNative = computed(() => {
    const setting = this.toolCallMode();
    if (setting === 'native') return true;
    if (setting === 'json') return false;
    return this.resolvedAutoIsNative().result;
  });

  /** Human-readable reason for the resolved auto mode — surfaced in UI tooltip. */
  effectiveToolCallReason = computed<string>(() => {
    const setting = this.toolCallMode();
    if (setting === 'native') return 'forced Native';
    if (setting === 'json') return 'forced JSON';
    const r = this.resolvedAutoIsNative();
    const verdict = r.result ? 'Native' : 'JSON';
    return `Auto: ${verdict} (${r.source})`;
  });

  /**
   * Resolve auto-mode for the current profile with provenance:
   *   explicit  — user set additionalSettings.supportsNativeToolCalls
   *   probed    — async probe (e.g. llama.cpp chat_template) reported a verdict
   *   default   — fell back to provider's static capability
   *   no profile — nothing selected
   */
  private resolvedAutoIsNative = computed<{ result: boolean, source: 'explicit' | 'probed' | 'default' | 'no profile' }>(() => {
    const id = this.selectedProfileId();
    const profile = id ? this.agentProfiles().find(p => p.id === id) : null;
    if (!profile || !id) return { result: false, source: 'no profile' };

    const explicit = this.readExplicitNativeFlag(profile.settings);
    if (explicit !== undefined) return { result: explicit, source: 'explicit' };

    const probed = this.probeResults()[id];
    if (typeof probed === 'boolean') return { result: probed, source: 'probed' };

    const cap = this.llmProviderRegistry.getProvider(profile.provider)?.getCapabilities(profile.settings);
    return { result: !!cap?.supportsNativeToolCalls, source: 'default' };
  });

  setToolCallMode(mode: ToolCallMode): void {
    this.toolCallMode.set(mode);
    const id = this.selectedProfileId();
    if (id) localStorage.setItem(TOOL_CALL_MODE_KEY_PREFIX + id, mode);
  }

  private loadToolCallMode(profileId: string | null): ToolCallMode {
    if (!profileId) return 'auto';
    const v = localStorage.getItem(TOOL_CALL_MODE_KEY_PREFIX + profileId);
    return v === 'native' || v === 'json' || v === 'auto' ? v : 'auto';
  }

  private readExplicitNativeFlag(settings: { additionalSettings?: Record<string, unknown> }): boolean | undefined {
    const v = settings.additionalSettings?.['supportsNativeToolCalls'];
    return typeof v === 'boolean' ? v : undefined;
  }

  /**
   * Kick off an async probe for the given profile when its provider exposes
   * one and the user hasn't pinned an explicit flag. The result is cached on
   * `probeResults[profileId]` and feeds into auto-mode resolution. Errors
   * are swallowed — falling back to the static default is the safe behavior.
   */
  private async kickToolSupportProbe(profileId: string): Promise<void> {
    const profile = this.agentProfiles().find(p => p.id === profileId);
    if (!profile) return;

    const provider = this.llmProviderRegistry.getProvider(profile.provider);
    if (!provider) return;

    if (this.readExplicitNativeFlag(profile.settings) === undefined && provider.probeNativeToolSupport) {
      try {
        const result = await provider.probeNativeToolSupport(profile.settings);
        if (this.selectedProfileId() === profileId) {
          this.probeResults.update(r => ({ ...r, [profileId]: result }));
        }
      } catch {
        // Probe failures are non-fatal; fall back to defaults
      }
    }

    const parallelExplicit = profile.settings.additionalSettings?.['supportsParallelToolCalls'];
    if (typeof parallelExplicit !== 'boolean' && provider.probeParallelToolSupport) {
      try {
        const result = await provider.probeParallelToolSupport(profile.settings);
        if (this.selectedProfileId() === profileId) {
          this.parallelProbeResults.update(r => ({ ...r, [profileId]: result }));
        }
      } catch {
        // Probe failures are non-fatal; fall back to defaults
      }
    }
  }

  toggleThought(index: number): void {
    this.agentLogs.update(logs => {
      const next = [...logs];
      if (next[index]) {
        next[index] = { ...next[index], isThoughtCollapsed: !next[index].isThoughtCollapsed };
      }
      return next;
    });
  }

  toggleToolCall(index: number): void {
    this.agentLogs.update(logs => {
      const next = [...logs];
      if (next[index]) {
        next[index] = { ...next[index], isToolCallCollapsed: !next[index].isToolCallCollapsed };
      }
      return next;
    });
  }

  toggleToolResult(index: number): void {
    this.agentLogs.update(logs => {
      const next = [...logs];
      if (next[index]) {
        next[index] = { ...next[index], isToolResultCollapsed: !next[index].isToolResultCollapsed };
      }
      return next;
    });
  }

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
      void this.kickToolSupportProbe(id);
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
    this.toolCallMode.set(this.loadToolCallMode(profileId));
    void this.kickToolSupportProbe(profileId);
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
    return this.effectiveToolCallModeIsNative() ? 'native' : 'json';
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
    const allowParallel = mode === 'native' && this.effectiveSupportsParallelToolCalls();
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
    const nativeFunctionCalls: LLMFunctionCall[] = [];
    const nativeFunctionCallParts: LLMPart[] = [];

    // Native-mode tool-call streaming heartbeat. Without this the user sees a
    // blank streaming entry while the provider assembles the functionCall
    // (which can take several seconds for large content writes). Show the
    // tool name on the first functionCall chunk, then throttle subsequent
    // updates so a chunk-count "heartbeat" reassures the user the model is
    // still progressing — provider-agnostic since we only count chunks.
    let firstFunctionCallSeen = false;
    let lastToolCallRenderAt = 0;
    const TOOL_CALL_HEARTBEAT_INTERVAL_MS = 100;

    this.promptProgress.set(undefined);

    try {
      for await (const chunk of stream) {
        this.generatedChunkCount.update(c => c + 1);
        if (chunk.usageMetadata?.promptProgress !== undefined) {
          this.promptProgress.set(chunk.usageMetadata.promptProgress);
        }
        if (chunk.usageMetadata?.candidates !== undefined) {
          this.generatedTokenCount.set(chunk.usageMetadata.candidates);
        } else {
          const legacyMetadata = chunk.usageMetadata as { candidatesTokenCount?: number } | undefined;
          if (legacyMetadata?.candidatesTokenCount !== undefined) {
            this.generatedTokenCount.set(legacyMetadata.candidatesTokenCount);
          }
        }
        if (chunk.functionCall) {
          this.promptProgress.set(undefined);
          // Collect every tool call when the model supports parallel calls;
          // otherwise keep only the first to preserve single-tool semantics.
          if (allowParallel || nativeFunctionCalls.length === 0) {
            nativeFunctionCalls.push(chunk.functionCall);
            // Store as LLMPart to preserve all stream metadata (e.g. thoughtSignature)
            nativeFunctionCallParts.push({ functionCall: chunk.functionCall, thoughtSignature: chunk.thoughtSignature });
          }
          const isFirst = !firstFunctionCallSeen;
          const now = Date.now();
          if (isFirst || now - lastToolCallRenderAt >= TOOL_CALL_HEARTBEAT_INTERVAL_MS) {
            firstFunctionCallSeen = true;
            lastToolCallRenderAt = now;
            const names = nativeFunctionCalls.map(fc => fc.name).join(', ');
            const countStr = this.generatedTokenCount() > 0 
              ? `${this.generatedTokenCount()} tokens` 
              : `${this.generatedChunkCount()} chunks`;
            const heartbeat = isFirst
              ? `Preparing tool: ${names}…`
              : `Preparing tool: ${names}… (${countStr} received)`;
            this.agentLogs.update(logs => {
              const next = [...logs];
              if (next[currentLogIndex]) {
                const text = accumulatedText.trim() 
                  ? `${accumulatedText.trim()}\n\n${heartbeat}` 
                  : heartbeat;
                next[currentLogIndex] = { ...next[currentLogIndex], text };
              }
              return next;
            });
          }
          continue;
        }
        if (chunk.text) {
          this.promptProgress.set(undefined);
          if (chunk.thought) {
            accumulatedThought += chunk.text;
            this.agentLogs.update(logs => {
              const next = [...logs];
              if (next[currentLogIndex]) {
                next[currentLogIndex] = { ...next[currentLogIndex], thought: accumulatedThought };
              }
              return next;
            });
          } else {
            accumulatedText += chunk.text;
            this.agentLogs.update(logs => {
              const next = [...logs];
              if (next[currentLogIndex]) {
                const entry = { ...next[currentLogIndex], text: accumulatedText };
                if (accumulatedThought && !hasCollapsedThought) {
                  entry.isThoughtCollapsed = true;
                }
                next[currentLogIndex] = entry;
              }
              return next;
            });
            hasCollapsedThought = true;
          }
        }
      }

      if (accumulatedThought && !hasCollapsedThought) {
        this.agentLogs.update(logs => {
          const next = [...logs];
          if (next[currentLogIndex]) {
            next[currentLogIndex] = { ...next[currentLogIndex], isThoughtCollapsed: true };
          }
          return next;
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
            toolName
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
              toolName
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
      this.agentLogs.update(logs => [
        ...logs,
        {
          role: 'model',
          text: JSON.stringify({ action: a.action, args: a.args }, null, 2),
          type: 'model' as const,
          isToolCall: true,
          isToolCallCollapsed: true,
          toolName
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
