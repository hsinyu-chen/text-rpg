import { LLMFunctionDeclaration } from '@hcs/llm-core';
import { type ReadOnlyAgentContext } from '../../../../agent-runner/read-only-agent';
import type { TurnContext } from '../../../../agent-runner/base-tool-call-agent';
import type { Awaitable, ReadOnlyAction, ToolExecutionResult } from '../../../../agent-runner/agent-runner.types';
import { BaseSaveSubAgent } from '../../base-save-sub-agent';
import type { AdvancedSaveAgentInput } from '../../advanced-save-agent';
import {
    COMMIT_TRIAGE_SELECTION,
    COMMIT_TRIAGE_SELECTION_TOOL,
    parseTriageSelectionArgs,
    resolveTriageSubset,
    type TriageEntitySelection,
    type TriageSelectionArgs,
    type TriageSeedContext,
} from './triage-selection-tool';

/** Action union — the read-only catalog plus this agent's single terminal. */
type TriageAction =
    | ReadOnlyAction
    | { action: typeof COMMIT_TRIAGE_SELECTION; args: unknown; callId?: string };

/**
 * Shared base for the two per-entity triage agents
 * ({@link import('./character-triage-agent').CharacterTriageAgent} and
 * {@link import('./faction-triage-agent').FactionTriageAgent}). One LLM call
 * per save reads the whole target file at once and decides **which entities
 * need per-entity processing** — it never writes a state update (its only exit
 * is `commitTriageSelection`).
 *
 * The gain: the expensive per-entity loop runs only on the selected subset
 * instead of every entity. The safety: recall over precision (include if
 * unsure), and any failure (provider error, no selection, abort surfaces) makes
 * {@link selectEntities} return `null` = "process all", so triage can never
 * silently drop a background entity that needed projection.
 */
export abstract class BaseEntityTriageAgent extends BaseSaveSubAgent<TriageAction> {
    /** Set by the terminal handler; consumed by `selectEntities` after the loop. */
    private capturedSelection: TriageSelectionArgs | null = null;
    private toolsCache: LLMFunctionDeclaration[] | null = null;

    /**
     * Decide which entities need per-entity processing this save. Returns the
     * selected subset (name + jobs + reason), or `null` to signal "process all"
     * — the safe degrade for any failure / empty result. An abort propagates
     * (via `runConversation`) so the save run stops.
     */
    async selectEntities(
        entities: readonly { name: string }[],
        targetFile: string,
        ctx: TriageSeedContext,
        input: AdvancedSaveAgentInput,
    ): Promise<TriageEntitySelection[] | null> {
        const entryId = this.progress.startEntry('advanced-agent', { toolName: this.traceLabel });
        this.capturedSelection = null;
        const ok = await this.runConversation(this.buildSeedMessage(entities, targetFile, ctx, input), entryId, input);
        if (!ok) return null;

        // Cast widens past TS's control-flow narrowing — the terminal handler
        // assigns this via a callback path inside processAgentTurn TS doesn't track.
        const selection = this.capturedSelection as TriageSelectionArgs | null;
        if (selection === null) {
            // Loop ended without a selection (maxTurns / commentary-only) — degrade to all.
            this.progress.finishEntry(entryId, 'done', 'no selection — processing all');
            return null;
        }
        const entityNames = new Set(entities.map(e => e.name));
        const { selected, warnings } = resolveTriageSubset(entityNames, selection);
        if (warnings.length) {
            console.warn(`[${this.traceLabel}] ${warnings.join('; ')}`);
            this.progress.setEntryWarnings(entryId, warnings);
        }
        this.progress.setEntryLogs(entryId, this.agentLogs());
        this.progress.finishEntry(entryId, 'done', `selected ${selected.length}/${entities.length}`);
        return selected;
    }

    // ===== BaseToolCallAgent / ReadOnlyAgent overrides =====

    protected override get tools(): LLMFunctionDeclaration[] {
        return (this.toolsCache ??= [...super.tools, COMMIT_TRIAGE_SELECTION_TOOL]);
    }

    protected override isTerminal(action: TriageAction): boolean {
        return action.action === COMMIT_TRIAGE_SELECTION;
    }

    protected override dispatchTool(
        action: TriageAction, context: ReadOnlyAgentContext,
    ): Awaitable<ToolExecutionResult> {
        const read = this.dispatchReadTool(action, context);
        if (read !== null) return read;
        // commitTriageSelection is terminal — it never routes through here.
        return { response: { error: `Unknown action: ${action.action}` } };
    }

    protected override async handleTerminalAction(
        _context: ReadOnlyAgentContext,
        terminalAction: TriageAction,
        _mode: 'native' | 'json',
        ctx: TurnContext,
    ): Promise<void> {
        this.capturedSelection = parseTriageSelectionArgs(terminalAction.args);
        const n = this.capturedSelection.entities.length;
        this.updateLogAt(ctx.currentLogIndex, e => ({
            ...e, text: `triage selected ${n} entit${n === 1 ? 'y' : 'ies'}`, isToolCall: false,
        }));
        this.isAgentRunning.set(false);
    }

    // ===== Internals =====

    private buildSeedMessage(
        entities: readonly { name: string }[],
        targetFile: string,
        ctx: TriageSeedContext,
        input: AdvancedSaveAgentInput,
    ): string {
        const roster = entities.map(e => `- ${e.name}`).join('\n');
        const fileHunks = input.hunks
            .filter(h => h.file === targetFile)
            .map(h => ({ id: h.id, context: h.context, target: h.target, replacement: h.replacement }));
        const fileContent = input.files.get(targetFile) ?? '(file not found)';
        return [
            `You are the triage step for "${targetFile}". Decide WHICH of the entities below need per-entity `
                + `processing this save. Do NOT make any edits — call ${COMMIT_TRIAGE_SELECTION} exactly once with the `
                + `subset (who, which jobs, why). When unsure, include the entity (recall over precision).`,
            '',
            `[ROSTER] — every entity in "${targetFile}" (${entities.length}). Copy names verbatim:`,
            roster,
            '',
            'Available KB files:',
            ctx.fileList,
            '',
            `[FULL FILE] — current content of "${targetFile}" (all cards, pre-apply baseline):`,
            '```markdown',
            fileContent,
            '```',
            '',
            "[EXISTING HUNKS] — the SaveAgent's proposed (unapplied) edits to this file:",
            '```json',
            JSON.stringify(fileHunks, null, 2),
            '```',
            '',
            `[ACT TIMESPAN] start: ${ctx.timeSpan.start || '(unknown)'} | end: ${ctx.timeSpan.end || '(unknown)'}`,
            '',
            "[ACT LOG DIGEST] — this ACT's character_log + world_log, by message id:",
            '```',
            ctx.logDigest,
            '```',
        ].join('\n');
    }
}
