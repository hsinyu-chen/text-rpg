import { Injectable, effect, inject, signal } from '@angular/core';
import type { LLMFunctionDeclaration, LLMProvider, LLMProviderConfig } from '@hcs/llm-core';
import type { ChatMessage } from '@app/core/models/types';
import { getLocale } from '@app/core/constants/locales';
import { DEFAULT_PROFILE_ID } from '@app/core/constants/prompt-profiles';
import { LLMConfigService } from '../../llm-config.service';
import { LLMProviderRegistryService } from '../../llm-provider-registry.service';
import { InjectionService } from '../../injection.service';
import { GameStateService } from '../../game-state.service';
import { ReadOnlyAgent, type ReadOnlyAgentContext } from '../../agent-runner/read-only-agent';
import type { TurnSetup, TurnContext } from '../../agent-runner/base-tool-call-agent';
import type { Awaitable, ReadOnlyAction, ToolExecutionResult } from '../../agent-runner/agent-runner.types';
import type { SaveHunk } from '../multi-agent-save.types';
import { SaveSettingsStore } from '../save-settings.store';
import { SaveProgressTracker } from '../progress/save-progress-tracker.service';
import type { AdvancedSaveAgent, AdvancedSaveAgentInput } from './advanced-save-agent';
import {
    COMMIT_INVENTORY_REVIEW,
    COMMIT_INVENTORY_REVIEW_TOOL,
    INVENTORY_CONSISTENCY_AGENT_ID,
    applyInventoryReview,
    parseCommitArgs,
} from './inventory-review-tool';
import type { CommitInventoryReviewArgs } from './inventory-review-tool';

/** Trace label shown on the agent's progress card. */
const AGENT_LABEL = 'InventoryConsistencyAgent';

/** Action union — the read-only catalog plus this agent's terminal commit. */
type InventoryAgentAction =
    | ReadOnlyAction
    | { action: typeof COMMIT_INVENTORY_REVIEW; args: unknown; callId?: string };

/**
 * First real {@link AdvancedSaveAgent}. When enabled it post-processes the
 * SaveAgent manifest's inventory hunks:
 *
 * - **Job 1 — verify**: cross-checks each `9.物品欄.md` hunk against the ACT's
 *   chat messages; drops hunks the story does not support, revises hunks whose
 *   item is real but whose details (quantity, property) are wrong.
 * - **Job 2 — detail settings**: for significant (non-mundane) items, ensures
 *   the tech-equipment file has a proper entry — appends a missing one, or
 *   deepens an existing one with what the current ACT revealed.
 *
 * It runs an LLM tool-call loop ({@link ReadOnlyAgent} read tools + the
 * `commitInventoryReview` terminal tool) and returns the full processed hunk
 * list. A failure degrades to identity — the manifest passes through untouched
 * — so the agent can never sink a save run.
 */
@Injectable({ providedIn: 'root' })
export class InventoryConsistencyAgent extends ReadOnlyAgent<InventoryAgentAction> implements AdvancedSaveAgent {
    readonly id = INVENTORY_CONSISTENCY_AGENT_ID;
    readonly i18nKey = 'advancedSaveAgents.inventoryConsistency';

    private llmConfig = inject(LLMConfigService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private injection = inject(InjectionService);
    private gameState = inject(GameStateService);
    private saveSettings = inject(SaveSettingsStore);
    private progress = inject(SaveProgressTracker);

    /** Bounded turn budget — a save sub-step shouldn't run as long as the
     *  file-agent's interactive editing loop. */
    protected override readonly maxTurns = 30;

    /** Loaded once per run in `process`, read synchronously by `resolveTurnSetup`. */
    private systemPrompt = '';
    /** Set by the terminal handler; consumed by `process` after the loop. */
    private capturedCommit: CommitInventoryReviewArgs | null = null;
    /** Progress entry id while a run is in flight — gates trace mirroring.
     *  Must be a signal so the constructor's PP-mirror effect re-runs when
     *  the entry changes (otherwise a back-to-back run whose first chunk's
     *  `promptProgress` value matches the previous run's last value would
     *  not re-fire the effect, and the new entry's PP bar would stay empty). */
    private activeEntryId = signal<string | null>(null);
    /** Tool-call mode resolved per run (one pre-loop probe). */
    private toolCallMode: 'native' | 'json' = 'json';
    /** Provider + settings resolved per run; reused across turns so a single
     *  run never switches provider mid-loop. */
    private resolvedProvider: { provider: LLMProvider; config: LLMProviderConfig } | null = null;

    private toolsCache: LLMFunctionDeclaration[] | null = null;

    constructor() {
        super();
        // Mirror the base loop's per-chunk `promptProgress` signal into the
        // active progress entry so the save dialog's PP bar reflects the
        // agent's prefill / prompt-processing progress (same UX as the
        // SaveAgentRunner). Both reads are signals so the effect re-fires on
        // either an entry-id swap or a new pp value.
        effect(() => {
            const pp = this.promptProgress();
            const id = this.activeEntryId();
            if (id && pp !== undefined) this.progress.setPpProgress(id, pp);
        });
        // Mirror the running log to the active progress entry on every change.
        // The base runner mutates `agentLogs` per streaming chunk (thought,
        // text, tool-call, tool-result), so the dialog's trace surface
        // re-renders live instead of only at turn boundaries — without it,
        // PP reaches 100 % and the user stares at an empty card until the
        // whole turn finishes.
        effect(() => {
            const id = this.activeEntryId();
            const logs = this.agentLogs();
            if (id) this.progress.setEntryLogs(id, logs);
        });
    }

    async process(input: AdvancedSaveAgentInput): Promise<SaveHunk[]> {
        const locale = getLocale(input.lang);
        const cf = locale.coreFilenames;
        const reviewFiles = {
            inventoryFile: cf.INVENTORY,
            assetsFile: cf.ASSETS,
            techEquipmentFile: cf.TECH_EQUIPMENT,
            worldFactionsFile: cf.WORLD_FACTIONS,
        };
        const inventoryFile = reviewFiles.inventoryFile;

        const entryId = this.progress.startEntry('advanced-agent', { toolName: AGENT_LABEL });
        // Reset PP + agentLogs BEFORE swapping the entry id — both mirror
        // effects fire the instant `activeEntryId` swaps. Without these
        // pre-resets the previous run's final PP (e.g. 1) and trailing
        // agentLogs from the prior turn would be stamped onto the new
        // entry, painting them into the dialog's auto-expanded panel for
        // the 0.5–2 s window between this line and the post-probe reset
        // at the start of the try block.
        this.promptProgress.set(undefined);
        this.agentLogs.set([]);
        this.activeEntryId.set(entryId);
        this.capturedCommit = null;

        // Bridge the save run's abort signal into the base loop's controller.
        // Capture the controller in a local so the listener closes over THIS
        // run's instance — the singleton field `this.abortController` gets
        // reassigned by the next run, and a late-firing abort listener that
        // reads `this.abortController` would otherwise abort the wrong run.
        const agentController = new AbortController();
        this.abortController = agentController;
        const abortHandler = (): void => agentController.abort();
        if (input.signal.aborted) agentController.abort();
        else input.signal.addEventListener('abort', abortHandler, { once: true });

        try {
            this.systemPrompt = await this.loadPrompt();
            this.resolvedProvider = this.resolveProvider();
            this.toolCallMode = await this.probeToolCallMode(this.resolvedProvider);
            this.agentHistory.set([{
                role: 'user',
                parts: [{ text: this.buildSeedMessage(input, inventoryFile) }],
            }]);
            this.isAgentRunning.set(true);
            await this.processAgentTurn({ files: input.files, chatMessages: input.chatMessages });
        } catch (err: unknown) {
            if (input.signal.aborted) {
                this.progress.skip(entryId, 'user_aborted');
                this.activeEntryId.set(null);
                throw err;
            }
            // A failed advanced-save agent must not sink the save — degrade to
            // identity so the user still gets the baseline manifest.
            console.error('[InventoryConsistencyAgent] run failed:', err);
            this.progress.finishEntry(entryId, 'failed', err instanceof Error ? err.message : String(err));
            this.activeEntryId.set(null);
            return [...input.hunks];
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

        // Cast widens past TS's control-flow narrowing. The `= null` reset
        // earlier in this method narrows `this.capturedCommit` to `null` for
        // TS — the terminal handler's assignment runs INSIDE
        // `processAgentTurn` via a callback path TS doesn't track, so without
        // the cast TS thinks `commit` is `null` and `if (commit === null)`
        // collapses the rest to `never`.
        const commit = this.capturedCommit as CommitInventoryReviewArgs | null;
        if (commit === null) {
            // Loop ended without a commit (maxTurns / commentary-only) — no-op.
            this.progress.finishEntry(entryId, 'done', 'no changes');
            return [...input.hunks];
        }
        const validMessageIds = new Set(input.chatMessages.map(m => m.id));
        const { hunks, warnings } = applyInventoryReview(input.hunks, commit, reviewFiles, validMessageIds);
        if (warnings.length) {
            console.warn('[InventoryConsistencyAgent] skipped inputs:', warnings.join('; '));
            this.progress.setEntryWarnings(entryId, warnings);
        }
        this.progress.setEntryLogs(entryId, this.agentLogs());
        this.progress.finishEntry(entryId, 'done', commit.summary || 'inventory review committed');
        return hunks;
    }

    // ===== BaseToolCallAgent / ReadOnlyAgent overrides =====

    protected override get tools(): LLMFunctionDeclaration[] {
        return (this.toolsCache ??= [...super.tools, COMMIT_INVENTORY_REVIEW_TOOL]);
    }

    protected override isTerminal(action: InventoryAgentAction): boolean {
        return action.action === COMMIT_INVENTORY_REVIEW;
    }

    protected override dispatchTool(
        action: InventoryAgentAction, context: ReadOnlyAgentContext,
    ): Awaitable<ToolExecutionResult> {
        const read = this.dispatchReadTool(action, context);
        if (read !== null) return read;
        // commitInventoryReview is terminal — it never routes through here.
        return { response: { error: `Unknown action: ${action.action}` } };
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
            // Keep single-tool-per-turn even in native mode — the loop is
            // already cheap and avoids the multi-action coordination surface.
            allowParallel: false,
            systemInstruction: this.systemPrompt,
            genConfig: this.buildGenConfig(mode, cap.isLocalProvider),
        };
    }

    /**
     * One pre-loop probe per run: native tool-call if the provider supports it,
     * JSON otherwise. Failures fall back to JSON — the universal-fallback path
     * always works, so a flaky probe never sinks an enabled save run.
     *
     * Unlike file-agent's per-profile cached probe, this fires fresh every run
     * (no cross-run sharing). The one extra tiny LLM call is acceptable for a
     * once-per-save signal — and it avoids any cache-staleness when the user
     * swaps the underlying model (llama.cpp GGUF reload, etc.) between saves.
     */
    private async probeToolCallMode(
        resolved: { provider: LLMProvider; config: LLMProviderConfig } | null,
    ): Promise<'native' | 'json'> {
        if (!resolved?.provider.probeNativeToolSupport) return 'json';
        try {
            return (await resolved.provider.probeNativeToolSupport(resolved.config)) ? 'native' : 'json';
        } catch {
            return 'json';
        }
    }

    /** Capture the committed delta, then stop the loop. The base terminal
     *  handler's `args.message` finalization doesn't fit this tool's shape,
     *  so this fully owns the terminal path. */
    protected override async handleTerminalAction(
        _context: ReadOnlyAgentContext,
        terminalAction: InventoryAgentAction,
        _mode: 'native' | 'json',
        ctx: TurnContext,
    ): Promise<void> {
        this.capturedCommit = parseCommitArgs(terminalAction.args);
        const summary = this.capturedCommit.summary || '(inventory review committed)';
        this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: summary, isToolCall: false }));
        this.isAgentRunning.set(false);
    }

    // ===== Internals =====

    /**
     * Resolves the LLM provider for this agent. A per-agent profile override
     * (`saveAgentProfileIds[id]`) wins; otherwise the active main chat profile
     * is used. Mirrors `HunkAutoFixService.resolveProvider`.
     */
    private resolveProvider(): { provider: LLMProvider; config: LLMProviderConfig } | null {
        const pickedId = this.saveSettings.saveAgentProfileIds()[this.id];
        if (pickedId) {
            const profile = this.llmConfig.profiles().find(p => p.id === pickedId);
            if (profile) {
                const provider = this.providerRegistry.getProvider(profile.provider);
                if (provider) return { provider, config: profile.settings };
            }
            console.warn(`[InventoryConsistencyAgent] profile '${pickedId}' not found; falling back to active.`);
        }
        return this.providerRegistry.getActiveBundle();
    }

    private async loadPrompt(): Promise<string> {
        const profileId = this.gameState.activePromptProfile() || DEFAULT_PROFILE_ID;
        return this.injection.getResolvedProfilePrompt('save_inventory_consistency', profileId);
    }

    private buildSeedMessage(input: AdvancedSaveAgentInput, inventoryFile: string): string {
        const manifest = input.hunks.map(h => ({
            id: h.id,
            file: h.file,
            context: h.context,
            target: h.target,
            replacement: h.replacement,
            sourceMessageIds: h.sourceMessageIds,
        }));
        const fileList = Array.from(input.files.keys()).map(f => `- ${f}`).join('\n');
        const actMessages = sliceToActStart(input.chatMessages);
        const logDigest = renderActLogDigest(actMessages);
        return [
            `The save manifest below has ${input.hunks.length} hunk(s). Review the inventory hunks `
                + `(file "${inventoryFile}") per your instructions, using the ACT log digest as your `
                + `ground truth, then call ${COMMIT_INVENTORY_REVIEW} exactly once.`,
            '',
            'Available KB files:',
            fileList,
            '',
            'Manifest hunks:',
            '```json',
            JSON.stringify(manifest, null, 2),
            '```',
            '',
            "ACT log digest (this ACT's `inventory_log` + `world_log` entries, by message id — reference info):",
            '```',
            logDigest,
            '```',
        ].join('\n');
    }
}

/**
 * Slice messages from the most recent `--- ACT START ---` marker onward —
 * the boundary the SaveAgent's prompt scopes to. Falls back to the full list
 * if the marker is not found (e.g. early-session edge cases).
 */
function sliceToActStart(messages: readonly ChatMessage[]): ChatMessage[] {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].content?.includes('--- ACT START ---')) {
            return messages.slice(i);
        }
    }
    return [...messages];
}

/**
 * Render the ACT's `inventory_log` + `world_log` entries as a compact digest
 * grouped by message id. The agent uses this as the starting anchor for
 * Job 1 verification and for noticing item lore worth Job 2 deepening.
 */
function renderActLogDigest(messages: readonly ChatMessage[]): string {
    const lines: string[] = [];
    for (const m of messages) {
        const inv = m.inventory_log ?? [];
        const world = m.world_log ?? [];
        if (inv.length === 0 && world.length === 0) continue;
        lines.push(`message ${m.id}:`);
        for (const e of inv) lines.push(`  [inventory] ${e}`);
        for (const e of world) lines.push(`  [world] ${e}`);
    }
    return lines.length ? lines.join('\n') : '(no inventory or world log entries in this ACT)';
}

/** Standard `AbortController`-style error so `isAbortError` in the orchestrator matches. */
function makeAbortError(): Error {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
}
