import { inject, signal } from '@angular/core';
import type { LLMProvider, LLMProviderConfig } from '@hcs/llm-core';
import { DEFAULT_PROFILE_ID } from '@app/core/constants/prompt-profiles';
import { LLMConfigService } from '../../llm-config.service';
import { LLMProviderRegistryService } from '../../llm-provider-registry.service';
import { InjectionService, type PromptType } from '../../injection.service';
import { GameStateService } from '../../game-state.service';
import { ReadOnlyAgent } from '../../agent-runner/read-only-agent';
import type { TurnSetup } from '../../agent-runner/base-tool-call-agent';
import type { BaseAction, ReadOnlyAction } from '../../agent-runner/agent-runner.types';
import { SaveSettingsStore } from '../save-settings.store';
import { SaveProgressTracker } from '../progress/save-progress-tracker.service';
import { installAgentProgressMirrors } from '../progress/agent-progress-mirror.util';
import { makeAbortError } from '../utils/abort-error.util';
import { resolveAutoToolCallMode } from '../utils/resolve-tool-call-mode.util';
import type { AdvancedSaveAgentInput } from './advanced-save-agent';

/**
 * Shared base for every LLM-driven save sub-agent (the inventory agent, the
 * per-entity state agents, and the per-entity triage agents). It owns the
 * machinery they all repeat verbatim:
 *
 * - **Provider / prompt resolution** — a per-agent profile override
 *   (`saveAgentProfileIds[id]`) wins, else the active main-chat profile;
 *   the agent's `promptType` is loaded through {@link InjectionService}.
 * - **Tool-call mode** — one probe per run via {@link resolveAutoToolCallMode}.
 * - **Turn setup** — `resolveTurnSetup` is identical across all of them.
 * - **Progress mirroring** — the constructor wires the PP / log / todo signals
 *   into a {@link SaveProgressTracker} entry keyed by {@link activeEntryId}.
 * - **One conversation** — {@link runConversation} resets loop state, bridges
 *   the save run's abort signal into a fresh per-conversation controller, seeds
 *   the history, and drives the tool-call loop, degrading a non-abort failure
 *   to a `false` return (the caller decides what passthrough means) while an
 *   abort always throws so the save run can stop.
 *
 * Subclasses supply the catalog + terminal handling (`tools`, `isTerminal`,
 * `dispatchTool`, `handleTerminalAction`) and read whatever terminal state they
 * captured after `runConversation` returns `true`.
 */
export abstract class BaseSaveSubAgent<TAction extends BaseAction = ReadOnlyAction>
    extends ReadOnlyAgent<TAction> {
    /** Stable id — the profile-override key in `saveAgentProfileIds`. */
    abstract readonly id: string;
    /** The prompt registered with {@link InjectionService} for this agent. */
    protected abstract readonly promptType: PromptType;
    /** Trace-card label, e.g. `CharacterStateAgent`. */
    protected abstract readonly traceLabel: string;

    protected llmConfig = inject(LLMConfigService);
    protected providerRegistry = inject(LLMProviderRegistryService);
    private injection = inject(InjectionService);
    private gameState = inject(GameStateService);
    private saveSettings = inject(SaveSettingsStore);
    protected progress = inject(SaveProgressTracker);

    /** Save sub-step — a tighter budget than the file-agent's interactive loop. */
    protected override readonly maxTurns = 30;

    /** Loaded by {@link prepareRun}; read synchronously by {@link resolveTurnSetup}. */
    protected systemPrompt = '';
    /** Provider + settings resolved per run; reused so one run never switches mid-loop. */
    protected resolvedProvider: { provider: LLMProvider; config: LLMProviderConfig } | null = null;
    /** Tool-call mode resolved per run (one pre-loop probe). */
    protected toolCallMode: 'native' | 'json' = 'json';
    /** Active progress entry id — a signal so the PP/log/todo mirror effects re-fire on swap. */
    protected activeEntryId = signal<string | null>(null);

    constructor() {
        super();
        installAgentProgressMirrors({
            progress: this.progress,
            activeEntryId: this.activeEntryId,
            promptProgress: this.promptProgress,
            agentLogs: this.agentLogs,
            todoList: this.todoList,
        });
    }

    /** Resolve prompt + provider + tool-call mode once. Call before a run; for a
     *  multi-conversation agent (per-entity) call once and pass `prepared: true`
     *  to {@link runConversation} so the probe isn't repeated per conversation. */
    protected async prepareRun(): Promise<void> {
        this.systemPrompt = await this.loadPrompt();
        this.resolvedProvider = this.resolveProvider();
        this.toolCallMode = this.resolvedProvider
            ? await resolveAutoToolCallMode(this.resolvedProvider.provider, this.resolvedProvider.config)
            : 'json';
    }

    /**
     * Drive ONE conversation from `seed`, mirroring progress into `entryId`.
     * Returns `true` when the loop ran to completion (the subclass's captured
     * terminal state is ready to read) or `false` when a non-abort failure
     * degraded it (the caller passes through). An abort always throws — either
     * the original error (when it surfaced as one) or a synthetic AbortError
     * (when the stream consumer swallowed it) — so the save run can stop.
     *
     * `prepared` skips {@link prepareRun} for callers that already prepared once
     * across multiple conversations.
     */
    protected async runConversation(
        seed: string, entryId: string, input: AdvancedSaveAgentInput, prepared = false,
    ): Promise<boolean> {
        // Reset loop state BEFORE swapping the entry id — the mirror effects fire
        // the instant `activeEntryId` swaps, so a stale PP / log / todo from a
        // previous conversation must not stamp onto this card.
        this.promptProgress.set(undefined);
        this.agentLogs.set([]);
        this.todoList.set([]);
        this.activeEntryId.set(entryId);

        // Bridge the save run's abort into a fresh per-conversation controller.
        // Capture it in a local so a late-firing listener aborts THIS run, not a
        // later one that reassigned the singleton `this.abortController`.
        const agentController = new AbortController();
        this.abortController = agentController;
        const abortHandler = (): void => agentController.abort();
        if (input.signal.aborted) agentController.abort();
        else input.signal.addEventListener('abort', abortHandler, { once: true });

        try {
            if (!prepared) await this.prepareRun();
            this.agentHistory.set([{ role: 'user', parts: [{ text: seed }] }]);
            this.isAgentRunning.set(true);
            await this.processAgentTurn({ files: input.files, chatMessages: input.chatMessages });
        } catch (err: unknown) {
            if (input.signal.aborted) {
                this.progress.skip(entryId, 'user_aborted');
                this.activeEntryId.set(null);
                throw err;
            }
            // A failed save sub-agent must not sink the save — degrade.
            console.error(`[${this.traceLabel}] run failed:`, err);
            this.progress.finishEntry(entryId, 'failed', err instanceof Error ? err.message : String(err));
            this.activeEntryId.set(null);
            return false;
        } finally {
            input.signal.removeEventListener('abort', abortHandler);
            this.isAgentRunning.set(false);
        }

        this.activeEntryId.set(null);
        // An abort can land without throwing — the stream consumer swallows
        // AbortError. Surface it so the orchestrator stops the save run.
        if (input.signal.aborted) {
            this.progress.skip(entryId, 'user_aborted');
            throw makeAbortError();
        }
        return true;
    }

    protected override resolveTurnSetup(): TurnSetup | null {
        const resolved = this.resolvedProvider;
        if (!resolved) return null;
        const cap = resolved.provider.getCapabilities(resolved.config);
        const mode = this.toolCallMode;
        return {
            provider: resolved.provider,
            providerSettings: resolved.config as unknown as Record<string, unknown>,
            mode,
            // Keep single-tool-per-turn even in native mode — the loop is already
            // cheap and avoids the multi-action coordination surface.
            allowParallel: false,
            systemInstruction: this.systemPrompt,
            genConfig: this.buildGenConfig(mode, cap.isLocalProvider),
        };
    }

    /** Per-agent profile override wins; else the active main-chat profile. */
    private resolveProvider(): { provider: LLMProvider; config: LLMProviderConfig } | null {
        const pickedId = this.saveSettings.saveAgentProfileIds()[this.id];
        if (pickedId) {
            const profile = this.llmConfig.profiles().find(p => p.id === pickedId);
            if (profile) {
                const provider = this.providerRegistry.getProvider(profile.provider);
                if (provider) return { provider, config: profile.settings };
            }
            console.warn(`[${this.traceLabel}] profile '${pickedId}' not found; falling back to active.`);
        }
        return this.providerRegistry.getActiveBundle();
    }

    private async loadPrompt(): Promise<string> {
        const profileId = this.gameState.activePromptProfile() || DEFAULT_PROFILE_ID;
        return this.injection.getResolvedProfilePrompt(this.promptType, profileId);
    }
}
