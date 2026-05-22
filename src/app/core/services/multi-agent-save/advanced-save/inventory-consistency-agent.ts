import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { LLMFunctionDeclaration, LLMProvider, LLMProviderConfig } from '@hcs/llm-core';
import type { ChatMessage } from '@app/core/models/types';
import { getLocale, getLangFolder } from '@app/core/constants/locales';
import { DEFAULT_PROFILE_ID, getProfileBasePath } from '@app/core/constants/prompt-profiles';
import { LLMConfigService } from '../../llm-config.service';
import { LLMProviderRegistryService } from '../../llm-provider-registry.service';
import { InjectionService } from '../../injection.service';
import { ReadOnlyAgent, type ReadOnlyAgentContext } from '../../agent-runner/read-only-agent';
import type { TurnSetup, TurnContext } from '../../agent-runner/base-tool-call-agent';
import type { AgentLogEntry, Awaitable, ReadOnlyAction, ToolExecutionResult } from '../../agent-runner/agent-runner.types';
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

/** Built-in system prompt for this agent — loaded from the language root. */
const PROMPT_FILE = 'injection_advanced_inventory_consistency.md';

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

    private http = inject(HttpClient);
    private llmConfig = inject(LLMConfigService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private injection = inject(InjectionService);
    private saveSettings = inject(SaveSettingsStore);
    private progress = inject(SaveProgressTracker);

    /** Bounded turn budget — a save sub-step shouldn't run as long as the
     *  file-agent's interactive editing loop. */
    protected override readonly maxTurns = 30;

    /** Loaded once per run in `process`, read synchronously by `resolveTurnSetup`. */
    private systemPrompt = '';
    /** Set by the terminal handler; consumed by `process` after the loop. */
    private capturedCommit: CommitInventoryReviewArgs | null = null;
    /** Progress entry id while a run is in flight — gates trace mirroring. */
    private activeEntryId: string | null = null;
    /** Tool-call mode resolved per run (one pre-loop probe). */
    private toolCallMode: 'native' | 'json' = 'json';
    /** Provider + settings resolved per run; reused across turns so a single
     *  run never switches provider mid-loop. */
    private resolvedProvider: { provider: LLMProvider; config: LLMProviderConfig } | null = null;

    private toolsCache: LLMFunctionDeclaration[] | null = null;

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
        this.activeEntryId = entryId;
        this.capturedCommit = null;

        // Bridge the save run's abort signal into the base loop's controller.
        this.abortController = new AbortController();
        if (input.signal.aborted) this.abortController.abort();
        else input.signal.addEventListener('abort', () => this.abortController?.abort(), { once: true });

        try {
            this.systemPrompt = await this.loadPrompt(input.lang);
            this.resolvedProvider = this.resolveProvider();
            this.toolCallMode = await this.probeToolCallMode(this.resolvedProvider);
            this.agentLogs.set([]);
            this.agentHistory.set([{
                role: 'user',
                parts: [{ text: this.buildSeedMessage(input, inventoryFile) }],
            }]);
            this.isAgentRunning.set(true);
            await this.processAgentTurn({ files: input.files, chatMessages: input.chatMessages });
        } catch (err: unknown) {
            this.isAgentRunning.set(false);
            if (input.signal.aborted) {
                this.progress.skip(entryId, 'user_aborted');
                this.activeEntryId = null;
                throw err;
            }
            // A failed advanced-save agent must not sink the save — degrade to
            // identity so the user still gets the baseline manifest.
            console.error('[InventoryConsistencyAgent] run failed:', err);
            this.progress.finishEntry(entryId, 'failed', err instanceof Error ? err.message : String(err));
            this.activeEntryId = null;
            return [...input.hunks];
        } finally {
            this.isAgentRunning.set(false);
        }

        this.activeEntryId = null;

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
        const { hunks, warnings } = applyInventoryReview(input.hunks, commit, reviewFiles);
        if (warnings.length) console.warn('[InventoryConsistencyAgent] skipped inputs:', warnings.join('; '));
        this.progress.setEntryOutput(entryId, renderAgentTrace(this.agentLogs()));
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

    protected override appendModelTurnToHistory(mode: 'native' | 'json', ctx: TurnContext): void {
        super.appendModelTurnToHistory(mode, ctx);
        this.mirrorTrace();
    }

    protected override pushToolResultLog(response: Record<string, unknown>, toolName?: string): void {
        super.pushToolResultLog(response, toolName);
        this.mirrorTrace();
    }

    // ===== Internals =====

    /** Mirror the agent's running trace into its single progress card. */
    private mirrorTrace(): void {
        if (this.activeEntryId) {
            this.progress.setEntryOutput(this.activeEntryId, renderAgentTrace(this.agentLogs()));
        }
    }

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

    private async loadPrompt(lang: string): Promise<string> {
        const path = `${getProfileBasePath(getLangFolder(lang), DEFAULT_PROFILE_ID)}/${PROMPT_FILE}`;
        const raw = await firstValueFrom(this.http.get(path, { responseType: 'text' }));
        return this.injection.applyPromptPlaceholders(raw, lang);
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

/** Flattens the agent's structured log entries into one readable trace blob. */
function renderAgentTrace(logs: readonly AgentLogEntry[]): string {
    return logs
        .map(l => {
            const parts: string[] = [];
            if (l.thought) parts.push(`[thought] ${l.thought}`);
            if (l.text) parts.push(l.text);
            return parts.join('\n');
        })
        .filter(Boolean)
        .join('\n\n');
}

/** Standard `AbortController`-style error so `isAbortError` in the orchestrator matches. */
function makeAbortError(): Error {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
}
