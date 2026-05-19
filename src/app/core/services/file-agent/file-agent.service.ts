import { Injectable, inject, signal, computed, resource, effect } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { LLMConfigService } from '../llm-config.service';
import { LLMProviderRegistryService } from '../llm-provider-registry.service';
import { LLMFunctionDeclaration } from '@hcs/llm-core';
import {
  FileAgentContext, FileAgentRunInput, ParsedAction, ToolExecutionResult,
  ChatReplaceProposal, ChatReplaceOutcome
} from './file-agent.types';
import { FILE_AGENT_TOOLS } from './file-agent-tools';
import { buildSystemInstruction } from './file-agent-prompts';
import { executeFileTool } from './file-agent-tool-executor';
import { WorldCompletionValidator } from './world-completion-validator';
import { sanitizeLatexToUnicode } from '@app/core/utils/latex.util';
import { ReadOnlyAgent } from '../agent-runner/read-only-agent';
import { TurnSetup, TerminalValidationResult } from '../agent-runner/base-tool-call-agent';
import { AgentCapabilityResolver } from './agent-capability-resolver';
import { KVStore } from '../kv/kv-store';
import { FileAgentSettingsStore } from './file-agent-settings.store';
import { I18nService } from '@app/core/i18n';
import { getLocale } from '@app/core/constants/locales';
import { AgentHintRegistry } from '@app/core/services/agent-hints/agent-hints.registry';
import { AgentPanelStateService } from './agent-panel-state.service';
import { BookRepository } from '@app/core/services/storage/book.repository';
import { CollectionService } from '@app/core/services/collection.service';
import { SessionService } from '@app/core/services/session.service';
import { FULLSCREEN_DIALOG_CONFIG } from '@app/shared/material/dialog-presets';
import { applyHarnessFallbacks } from './normalize-message-links.util';
import { toAgentYaml } from './file-agent-yaml.util';

/**
 * Thrown by the service's default `onFileReplaced` when a write tool fires
 * but the registered edit channel (file-viewer's Monaco buffer) is gone —
 * typically because the user closed the File Viewer dialog mid-turn. The
 * `executeSingleAction` / `executeBatchActions` catch sites convert this
 * into a structured tool error response so the LLM sees the failure as
 * just-another tool error and stops attempting further writes, instead of
 * the whole `runAgent` aborting with an uncaught error.
 */
export class EditChannelLostError extends Error {
  constructor(public readonly filename: string, public readonly size: number) {
    super(`Edit channel lost mid-write: ${filename} (${size} chars dropped)`);
    this.name = 'EditChannelLostError';
  }
}

const EDIT_CHANNEL_LOST_TOOL_MESSAGE =
  '[user interrupt the editing] The editing surface (File Viewer) was closed by the user mid-turn; this write was dropped. STOP attempting further writes this turn — open a fresh turn after the user re-opens the File Viewer. Use submitResponse to acknowledge the interruption.';

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
@Injectable({ providedIn: 'root' })
export class FileAgentService extends ReadOnlyAgent<ParsedAction, FileAgentContext> {
  private llmConfigService = inject(LLMConfigService);
  private llmProviderRegistry = inject(LLMProviderRegistryService);
  private kv = inject(KVStore);
  private settings = inject(FileAgentSettingsStore);
  private i18n = inject(I18nService);
  private hintRegistry = inject(AgentHintRegistry);
  private bookRepo = inject(BookRepository);
  private collections = inject(CollectionService);
  private session = inject(SessionService);
  // `panelState` + `matDialog` power the default `onFileReplaced` and
  // `proposers.chatReplace` that runAgent supplies when the caller omits them.
  // UI surfaces (AgentConsoleComponent) now omit both — the agent loop is
  // owned end-to-end by this service, so closing the console mid-turn no
  // longer drops a closure the loop still needs.
  private panelState = inject(AgentPanelStateService);
  private matDialog = inject(MatDialog);
  private completionValidator: WorldCompletionValidator | null = null;

  setCompletionValidator(v: WorldCompletionValidator): void {
    this.completionValidator = v;
  }

  agentProfiles = this.llmConfigService.profiles;
  /** Shared across all file-agent surfaces (dialog + main-screen) via FileAgentSettingsStore. */
  selectedProfileId = this.settings.selectedProfileId;
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
    probeFailureTimestamps: this.settings.probeFailureTimestamps,
    parallelProbeFailureTimestamps: this.settings.parallelProbeFailureTimestamps,
    recordProbeFailure: (id, at) => this.settings.recordProbeFailure(id, at),
    recordParallelProbeFailure: (id, at) => this.settings.recordParallelProbeFailure(id, at),
    clearProbeFailure: id => this.settings.clearProbeFailure(id),
    clearParallelProbeFailure: id => this.settings.clearParallelProbeFailure(id),
    probeInflight: this.settings.probeInflight,
    parallelProbeInflight: this.settings.parallelProbeInflight
  });

  /** True when the agent loop is mid-turn AND no surface is showing it
   *  (chat panel closed; PiP-open implies panel-open so `!isOpen()` covers
   *  both). UI surfaces bind this to a pulse animation so the user still
   *  sees activity. Lives here so chat-input and file-viewer share one
   *  source of truth instead of each duplicating the logic.
   *
   *  `isAgentRunning` itself lives on {@link ReadOnlyAgent} (inherited). */
  isAgentRunningHidden = computed(() =>
    this.isAgentRunning() && !this.panelState.isOpen()
  );
  /** True while a propose-tool's approval dialog is open and the agent
   *  turn is paused waiting for the user to Apply / Cancel. Distinct
   *  from `isAgentRunning` (which is also true here) so the UI can
   *  swap the "thinking..." indicator for an "awaiting your input"
   *  hint and disable the prompt input to make clear the agent has
   *  yielded — not stuck mid-generation. */
  awaitingProposerDialog = signal(false);

  // Loop-state signals (agentHistory / agentLogs / isAgentRunning /
  // generatedTokenCount / generatedChunkCount / promptProgress) +
  // abortController + the stream-event handler map all live on the
  // BaseToolCallAgent base class — inherited via ReadOnlyAgent.

  constructor() {
    super();
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
        // Single-model providers (llama.cpp) probe /props and return one entry
        // whose id is the loaded GGUF's model_alias — which usually does NOT
        // match a user-typed (or empty / 'local-model') profile.settings.modelId.
        // Fall back to models[0] so the probe's contextSize still surfaces.
        const model = models.find(m => m.id === modelId)
          ?? (models.length === 1 ? models[0] : null);
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

  // clearHistory is inherited from BaseToolCallAgent — no file-agent-specific
  // signals need clearing beyond what the base resets.

  async runAgent(prompt: string, input: FileAgentRunInput): Promise<void> {
    if (!prompt || this.isAgentRunning()) return;
    // Clear "last batch's writes" so observers (file-viewer's diff-view
    // effect, etc.) don't keep showing the prior turn's replacements while
    // this turn is still in its thinking phase.
    this.lastFilesReplaced.set([]);

    const profileId = this.selectedProfileId();
    if (!profileId) {
      this.agentLogs.update(logs => [...logs, { role: 'system', text: 'No LLM profile selected.', type: 'error' }]);
      return;
    }

    this.abortController = new AbortController();
    this.isAgentRunning.set(true);
    // generatedTokenCount / generatedChunkCount / promptProgress get reset
    // per-turn at the top of BaseToolCallAgent.processAgentTurn.
    this.agentLogs.update(logs => [...logs, { role: 'user', text: prompt, type: 'info' }]);

    // Tag the prompt with two orthogonal markers so the LLM perceives both
    // axes across turns without rebuilding the system prompt (which would
    // invalidate the KV cache):
    //   [surface: main|file-edit]      — which physical AgentConsole is invoking
    //   [kb-file-writes: enabled|disabled] — whether write tools are honored
    // The system prompt's "EDITING SURFACE" block tells the LLM how to read
    // the markers; runtime gating still lives on `context.readOnly` enforced
    // by the tool executor. Only the history / LLM-bound copy carries the
    // tag — agentLogs above shows the user's original text.
    const surface = input.surface ?? 'main';
    const writes = input.readOnly ? 'disabled' : 'enabled';
    const tag = `[surface: ${surface}]\n[kb-file-writes: ${writes}]\n`;
    const newHistory = [...this.agentHistory(), { role: 'user' as const, parts: [{ text: tag + prompt }] }];
    this.agentHistory.set(newHistory);

    // Augment context with the uiMap callback + library snapshots so the
    // executor stays DI-free. Caller-supplied fields win — useful for tests.
    // Library snapshot is best-effort: BookRepository read failures shouldn't
    // block an editing turn that doesn't touch listBooks at all. Run the two
    // IDB-backed snapshot reads in parallel; they're independent.
    const [books, collections] = await Promise.all([
      input.books ?? this.snapshotBooks(),
      input.collections ?? this.snapshotCollections(),
    ]);
    const augmentedContext: FileAgentContext = {
      ...input,
      onFileReplaced: input.onFileReplaced ?? this.defaultOnFileReplaced,
      proposers: input.proposers ?? this.defaultProposers(),
      uiMap: input.uiMap ?? (() => this.hintRegistry.buildUiMap()),
      books,
      collections,
      activeBookId: input.activeBookId ?? this.session.currentBookId(),
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
    } finally {
      // Single guaranteed reset point. Inner methods on BaseToolCallAgent
      // (consumeStream / handleJsonParseError / handleTerminalAction /
      // processAgentTurn's commentary-only branch) still flip the signal
      // early so the UI can react before the call stack unwinds, but this
      // finally ensures every exit path — including resolveTurnSetup
      // returning null mid-recursion when selectedProfileId becomes null —
      // also clears it.
      this.isAgentRunning.set(false);
      this.abortController = null;
    }
  }

  /**
   * Default write sink for UI surfaces. Reads the current edit channel at
   * write time (NOT at runAgent start) — if the file-viewer closes mid-turn
   * the channel is null and we throw `EditChannelLostError`. The catch site
   * in our `dispatchTool` override converts that into a tool error response
   * so the LLM sees the failure as a tool error (not an aborted run) and
   * decides whether to retry / submitResponse.
   *
   * Bound as an arrow so it can be passed by reference without losing `this`.
   * Public so headless callers (bridge agent_ask) can wrap it with a
   * per-call collector instead of duplicating the channel-write / log /
   * throw logic.
   */
  defaultOnFileReplaced = (filename: string, content: string): void => {
    const live = this.panelState.editChannel();
    if (live) {
      live.write(filename, content);
      return;
    }
    // Don't push a separate agentLogs entry here — the throw routes through
    // dispatchTool's catch → tool-error response → pushToolResultLog, which
    // already surfaces EDIT_CHANNEL_LOST_TOOL_MESSAGE in the console.
    // Logging twice for the same interrupt is just noise.
    throw new EditChannelLostError(filename, content.length);
  };

  /**
   * Default `proposers` bag for UI surfaces. Opens the chat-replace approval
   * dialog via the root MatDialog, surfacing `awaitingProposerDialog` to swap
   * the spinner for a "waiting for your approval" hint in the console UI.
   * Bridge / tests pass their own proposers (usually omitted — the executor
   * then returns a structured "not wired" error).
   */
  private defaultProposers(): FileAgentContext['proposers'] {
    return {
      chatReplace: (params: ChatReplaceProposal) => this.openProposeChatReplace(params),
    };
  }

  private async openProposeChatReplace(params: ChatReplaceProposal): Promise<ChatReplaceOutcome> {
    const mod = await import('@app/features/chat/components/chat-replace-dialog/chat-replace-dialog.component');
    const data: import('@app/features/chat/components/chat-replace-dialog/chat-replace-dialog.component').ChatReplaceDialogData = { prefill: params };
    this.awaitingProposerDialog.set(true);
    try {
      const ref = this.matDialog.open(mod.ChatReplaceDialogComponent, {
        data,
        ...FULLSCREEN_DIALOG_CONFIG,
      });
      const result = (await firstValueFrom(ref.afterClosed())) as ChatReplaceOutcome | undefined;
      return result ?? { applied: null, cancelled: true, divergedFromProposal: false };
    } finally {
      this.awaitingProposerDialog.set(false);
    }
  }

  private async snapshotBooks(): Promise<FileAgentContext['books']> {
    try {
      const all = await this.bookRepo.list();
      return all.map(b => ({
        id: b.id,
        name: b.name,
        collectionId: b.collectionId,
        lastActiveAt: b.lastActiveAt,
        turnCount: b.messages?.length ?? 0,
      }));
    } catch (e) {
      console.warn('[FileAgent] snapshotBooks failed', e);
      return [];
    }
  }

  private async snapshotCollections(): Promise<FileAgentContext['collections']> {
    // Sidebar normally primes the signal on first mount; the migration service
    // also loads at app start. Re-load defensively so a file-agent invoked
    // before either has run still gets a populated list.
    if (this.collections.collections().length === 0) {
      try { await this.collections.load(); } catch (e) { console.warn('[FileAgent] collections load failed', e); }
    }
    return this.collections.collections().map(c => ({ id: c.id, name: c.name }));
  }

  override stopAgent(): void {
    super.stopAgent();
    // Defensive: if the user manages to hit Stop after the abort but before
    // the in-flight proposer dialog closes (rare race), make sure the UI's
    // "waiting for approval" indicator doesn't strand. The dialog's
    // try/finally also clears this — this is belt-and-suspenders.
    this.awaitingProposerDialog.set(false);
  }

  private resolveToolCallMode(): 'native' | 'json' {
    return this.capability.effectiveToolCallModeIsNative() ? 'native' : 'json';
  }

  /**
   * Resolve profile + provider + tool-call mode + system prompt + gen
   * config for this turn. Returns null on a missing profile id (caller
   * silently bails — the runAgent guard already logged the user-facing
   * "no profile selected" message).
   *
   * Implements the abstract method declared on
   * {@link import('../agent-runner/base-tool-call-agent').BaseToolCallAgent}.
   */
  protected override resolveTurnSetup(context: FileAgentContext): TurnSetup | null {
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

    const genConfig = this.buildGenConfig(mode, cap.isLocalProvider);

    // Per-turn signal resets (generatedTokenCount / generatedChunkCount /
    // promptProgress) are owned by BaseToolCallAgent.processAgentTurn so every
    // subclass gets consistent state — no redundant reset here.

    return { provider, providerSettings: profile.settings as unknown as Record<string, unknown>, mode, allowParallel, systemInstruction, genConfig };
  }

  // ===== ReadOnlyAgent / BaseToolCallAgent overrides =====

  /** i18n label for the harness-fallback link rewriter. Looked up per-call
   *  so locale switches mid-session take effect on the next tool result;
   *  i18n.translate is a Map lookup so per-call cost is negligible. */
  private harnessLabels(): { messageLink: string } {
    return { messageLink: this.i18n.translate('dialog.agentHarnessMessageLink') };
  }

  /** File-agent's text post-processing: LaTeX sanitize + harness fallbacks
   *  (code-unwrap / empty-label backfill / relabel ugly / GUID auto-link /
   *  adjacent-dup collapse). Base default is identity. */
  protected override processModelText(text: string): string {
    return applyHarnessFallbacks(sanitizeLatexToUnicode(text), this.harnessLabels());
  }

  // processToolMessageArg uses the base default (string-coerce + delegate to
  // processModelText) — file-agent doesn't need an override because the
  // string-coercion + harness pipeline are already chained through
  // processModelText above.

  protected override formatToolResult(response: Record<string, unknown>): string {
    return toAgentYaml(response);
  }

  protected override formatToolCallEntryText(a: ParsedAction): string {
    return toAgentYaml({ action: a.action, args: a.args });
  }

  /** File-agent action labels include the target filename so the trace
   *  log header reads `readFile(foo.md)` instead of just `readFile`. */
  protected override formatToolName(a: ParsedAction): string {
    const args = a.args as unknown as Record<string, unknown>;
    const filename = (typeof args['filename'] === 'string') ? args['filename'] : '';
    return `${a.action}(${filename})`;
  }

  /** WorldCompletionValidator hook for the submitResponse terminal action.
   *  Returns `valid: true` when no validator is set (e.g. file-agent invoked
   *  outside world-creation mode) or when the world is already marked
   *  completed. The action / context args are unused — gate state lives
   *  entirely on `this.completionValidator`. */
  protected override validateBeforeTerminal(): TerminalValidationResult {
    if (this.completionValidator && !this.completionValidator.isCompleted) {
      const v = this.completionValidator.validate();
      if (!v.valid) return { valid: false, errorMessage: v.errorMessage };
    }
    return { valid: true };
  }

  protected override isTerminal(action: ParsedAction): boolean {
    return action.action === 'submitResponse';
  }

  protected override get tools(): LLMFunctionDeclaration[] {
    return FILE_AGENT_TOOLS;
  }

  /**
   * Accumulator for the multi-action batch path. `null` outside a batch —
   * dispatchTool then emits `lastFilesReplaced.set(...)` per-call (single
   * action mode). When set (between `onBatchLoopStart` / `onBatchLoopEnd`),
   * dispatchTool pushes per-call writes into here instead, and onBatchLoopEnd
   * emits ONE signal update after the loop completes. Prevents file-viewer
   * diff-view flicker between awaited dispatchTool calls in a batch.
   */
  private batchReplacementsCollector: { filename: string; content: string }[] | null = null;

  protected override onBatchLoopStart(): void {
    this.batchReplacementsCollector = [];
  }

  protected override onBatchLoopEnd(): void {
    const collected = this.batchReplacementsCollector;
    this.batchReplacementsCollector = null;
    if (collected && collected.length > 0) {
      this.lastFilesReplaced.set(collected);
    }
  }

  /**
   * Augments ReadOnlyAgent.dispatchTool by:
   * - Falling back to `executeFileTool` for file-agent tools (write +
   *   UI-help + propose + flow-control) when the read-tool dispatcher
   *   doesn't claim the action.
   * - Wrapping `context.onFileReplaced` to surface each write into
   *   `lastFilesReplaced` so the file-viewer diff-view effect picks them up.
   *   In batch mode (between `onBatchLoopStart` / `onBatchLoopEnd`), writes
   *   accumulate locally for a single end-of-loop signal update; in
   *   single-action mode, the signal fires per call.
   * - Catching `EditChannelLostError` (raised when the user closes the
   *   File Viewer mid-write) and returning a structured tool error so the
   *   LLM treats it as a tool failure (not an aborted run) and stops
   *   attempting further writes via the same channel.
   */
  protected override async dispatchTool(action: ParsedAction, context: FileAgentContext): Promise<ToolExecutionResult> {
    // Try read tools first — never need the lastFilesReplaced wrapper or
    // EditChannelLost catch.
    const read = this.dispatchReadTool(action, context);
    if (read !== null) return read;

    // File-agent-specific tools (write / UI-help / propose / flow-control).
    // Wrap onFileReplaced so each per-tool write surfaces into lastFilesReplaced.
    const replaced: { filename: string; content: string }[] = [];
    const wrapped: FileAgentContext = {
      ...context,
      onFileReplaced: (f, c) => { context.onFileReplaced(f, c); replaced.push({ filename: f, content: c }); },
    };
    try {
      const result = await executeFileTool(action, wrapped);
      if (replaced.length > 0) {
        if (this.batchReplacementsCollector !== null) {
          // Batch mode — defer the signal update to onBatchLoopEnd.
          this.batchReplacementsCollector.push(...replaced);
        } else {
          // Single-action mode — fire the signal immediately.
          this.lastFilesReplaced.set(replaced);
        }
      }
      return result;
    } catch (e) {
      if (e instanceof EditChannelLostError) {
        return { response: { status: 'error', message: EDIT_CHANNEL_LOST_TOOL_MESSAGE, fileChanged: false } };
      }
      throw e;
    }
  }

}
