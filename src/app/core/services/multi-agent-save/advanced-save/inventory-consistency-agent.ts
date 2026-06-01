import { Injectable } from '@angular/core';
import { LLMFunctionDeclaration } from '@hcs/llm-core';
import { getLocale } from '@app/core/constants/locales';
import type { PromptType } from '../../injection.service';
import { type ReadOnlyAgentContext } from '../../agent-runner/read-only-agent';
import type { TurnContext } from '../../agent-runner/base-tool-call-agent';
import type { ReadOnlyAction } from '../../agent-runner/agent-runner.types';
import type { SaveHunk } from '../multi-agent-save.types';
import { sliceToActStart, renderActLogDigest } from '../utils/act-window.util';
import { BaseSaveSubAgent } from './base-save-sub-agent';
import type { AdvancedSaveAgent, AdvancedSaveAgentInput } from './advanced-save-agent';
import {
    COMMIT_INVENTORY_REVIEW,
    COMMIT_INVENTORY_REVIEW_TOOL,
    INVENTORY_CONSISTENCY_AGENT_ID,
    applyInventoryReview,
    parseCommitArgs,
} from './inventory-review-tool';
import type { CommitInventoryReviewArgs } from './inventory-review-tool';

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
 * Runs one {@link BaseSaveSubAgent} conversation (read tools + the
 * `commitInventoryReview` terminal) and returns the full processed hunk list.
 * A failure degrades to identity — the manifest passes through untouched — so
 * the agent can never sink a save run.
 */
@Injectable({ providedIn: 'root' })
export class InventoryConsistencyAgent extends BaseSaveSubAgent<InventoryAgentAction> implements AdvancedSaveAgent {
    readonly id = INVENTORY_CONSISTENCY_AGENT_ID;
    readonly i18nKey = 'advancedSaveAgents.inventoryConsistency';
    protected readonly promptType: PromptType = 'save_inventory_consistency';
    protected readonly traceLabel = 'InventoryConsistencyAgent';

    /** Set by the terminal handler; consumed by `process` after the loop. */
    private capturedCommit: CommitInventoryReviewArgs | null = null;
    private toolsCache: LLMFunctionDeclaration[] | null = null;

    async process(input: AdvancedSaveAgentInput): Promise<SaveHunk[]> {
        const cf = getLocale(input.lang).coreFilenames;
        const reviewFiles = {
            inventoryFile: cf.INVENTORY,
            assetsFile: cf.ASSETS,
            techEquipmentFile: cf.TECH_EQUIPMENT,
            worldFactionsFile: cf.WORLD_FACTIONS,
        };

        const entryId = this.progress.startEntry('advanced-agent', { toolName: this.traceLabel });
        this.capturedCommit = null;
        const ok = await this.runConversation(this.buildSeedMessage(input, reviewFiles.inventoryFile), entryId, input);
        if (!ok) return [...input.hunks];

        // Cast widens past TS's control-flow narrowing — the terminal handler
        // assigns this via a callback path inside processAgentTurn TS doesn't track.
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
        const logDigest = renderActLogDigest(actMessages, [
            { key: 'inventory_log', label: 'inventory' },
            { key: 'world_log', label: 'world' },
        ]);
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
