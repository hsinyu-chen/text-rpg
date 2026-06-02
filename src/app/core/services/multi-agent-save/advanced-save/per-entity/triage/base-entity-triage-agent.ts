import type { LLMFunctionDeclaration } from '@hcs/llm-core';
import { type ReadOnlyAgentContext } from '../../../../agent-runner/read-only-agent';
import type { TurnContext } from '../../../../agent-runner/base-tool-call-agent';
import type { ReadOnlyAction } from '../../../../agent-runner/agent-runner.types';
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
     * Decide which of the **no-hunk** `candidates` need per-entity processing
     * this save — the ones the SaveAgent already changed are handled
     * unconditionally and are passed only as `autoIncluded` context. Returns
     * the selected subset (name + jobs + reason), or `null` to signal "process
     * all candidates" — the safe degrade for any failure / no selection. An
     * abort propagates (via `runConversation`) so the save run stops.
     */
    async selectEntities(
        candidates: readonly { name: string }[],
        autoIncluded: readonly string[],
        targetFile: string,
        ctx: TriageSeedContext,
        input: AdvancedSaveAgentInput,
    ): Promise<TriageEntitySelection[] | null> {
        const entryId = this.progress.startEntry('advanced-agent', { toolName: this.traceLabel });
        this.capturedSelection = null;
        const seed = this.buildSeedMessage(candidates, autoIncluded, targetFile, ctx, input);
        const ok = await this.runConversation(seed, entryId, input);
        if (!ok) return null;

        // Cast widens past TS's control-flow narrowing — the terminal handler
        // assigns this via a callback path inside processAgentTurn TS doesn't track.
        const selection = this.capturedSelection as TriageSelectionArgs | null;
        if (selection === null) {
            // Loop ended without a selection (maxTurns / commentary-only) — degrade to all.
            this.progress.finishEntry(entryId, 'done', 'undecided — processing all candidates');
            return null;
        }
        const candidateNames = new Set(candidates.map(e => e.name));
        const { selected, warnings } = resolveTriageSubset(candidateNames, selection);
        if (warnings.length) {
            console.warn(`[${this.traceLabel}] ${warnings.join('; ')}`);
            this.progress.setEntryWarnings(entryId, warnings);
        }
        this.progress.setEntryLogs(entryId, this.agentLogs());
        this.progress.finishEntry(entryId, 'done', `selected ${selected.length}/${candidates.length} no-hunk entit${candidates.length === 1 ? 'y' : 'ies'}`);
        return selected;
    }

    // ===== BaseToolCallAgent / ReadOnlyAgent overrides =====

    protected override get tools(): LLMFunctionDeclaration[] {
        return (this.toolsCache ??= [...super.tools, COMMIT_TRIAGE_SELECTION_TOOL]);
    }

    protected override isTerminal(action: TriageAction): boolean {
        return action.action === COMMIT_TRIAGE_SELECTION;
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
        candidates: readonly { name: string }[],
        autoIncluded: readonly string[],
        targetFile: string,
        ctx: TriageSeedContext,
        input: AdvancedSaveAgentInput,
    ): string {
        const candidateList = candidates.map(e => `- ${e.name}`).join('\n');
        const autoList = autoIncluded.length ? autoIncluded.map(n => `- ${n}`).join('\n') : '(none)';
        const fileHunks = input.hunks
            .filter(h => h.file === targetFile)
            .map(h => ({ id: h.id, context: h.context, target: h.target, replacement: h.replacement }));
        const fileContent = input.files.get(targetFile) ?? '(file not found)';
        return [
            `You are the triage step for "${targetFile}". The [CANDIDATES] below have NO SaveAgent change this save. `
                + `Decide WHICH of them still need per-entity processing — either the SaveAgent missed a real change to `
                + `them this ACT (Job A), or meaningful time passed and they plausibly evolved off-screen (Job B). `
                + `Do NOT make any edits — call ${COMMIT_TRIAGE_SELECTION} exactly once with the subset (who, which `
                + `jobs, why). When unsure, include the candidate (recall over precision).`,
            '',
            `[CANDIDATES] — no-hunk entities you decide among (${candidates.length}). Copy names verbatim:`,
            candidateList,
            '',
            '[ALREADY HANDLED] — entities the SaveAgent already changed; processed unconditionally, listed for context '
                + 'only. Do NOT select these:',
            autoList,
            '',
            'Available KB files:',
            ctx.fileList,
            '',
            `[FULL FILE] — current content of "${targetFile}" (all cards, pre-apply baseline):`,
            '```markdown',
            fileContent,
            '```',
            '',
            "[SAVEAGENT HUNKS] — the SaveAgent's proposed (unapplied) edits to this file (they target the ALREADY "
                + 'HANDLED entities; shown so you can see what changed):',
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
