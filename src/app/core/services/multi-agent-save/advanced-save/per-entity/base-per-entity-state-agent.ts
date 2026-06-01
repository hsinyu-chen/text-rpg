import { LLMFunctionDeclaration } from '@hcs/llm-core';
import type { ChatMessage } from '@app/core/models/types';
import { getLocale } from '@app/core/constants/locales';
import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import { extractSceneHeader } from '@app/core/utils/scene-header.util';
import { I18nService } from '../../../../i18n/i18n.service';
import { inject } from '@angular/core';
import { type ReadOnlyAgentContext } from '../../../agent-runner/read-only-agent';
import type { TurnContext } from '../../../agent-runner/base-tool-call-agent';
import type { Awaitable, ReadOnlyAction, ToolExecutionResult } from '../../../agent-runner/agent-runner.types';
import type { SaveHunk } from '../../multi-agent-save.types';
import { sliceToActStart, renderActLogDigest } from '../../utils/act-window.util';
import { makeAbortError } from '../../utils/abort-error.util';
import { extractFormatTemplate } from '../../utils/extract-format-template.util';
import { BaseSaveSubAgent } from '../base-save-sub-agent';
import type { AdvancedSaveAgent, AdvancedSaveAgentInput } from '../advanced-save-agent';
import type { BaseEntityTriageAgent } from './triage/base-entity-triage-agent';
import type { TriageSeedContext } from './triage/triage-selection-tool';
import {
    COMMIT_ENTITY_STATE_REVIEW,
    COMMIT_ENTITY_STATE_REVIEW_TOOL,
    REPORT_NOT_AN_ENTITY,
    REPORT_NOT_AN_ENTITY_TOOL,
    applyEntityStateReview,
    parseCommitEntityStateArgs,
    parseReportNotAnEntityArgs,
    type CommitEntityStateReviewArgs,
    type ReportNotAnEntityArgs,
} from './entity-state-review-tool';

/** Minimum entity shape both providers return ({@link import('../multi-agent-save.types').CharacterEntry} / FactionEntry). */
export interface PerEntityState {
    name: string;
    headingPath: string;
    group: string;
    rawText: string;
}

/** Aggregate-warning gate: warn only when the run had at least this many
 *  entities AND at least this fraction were judged non-entities — a couple of
 *  stray template entries shouldn't trip the "provider mismatch" banner. */
const MISMATCH_MIN_ENTITIES = 4;
const MISMATCH_RATIO = 0.5;

/**
 * Whether a run's non-entity rate should raise the format-mismatch banner.
 * Pure so the threshold logic is unit-testable without driving the LLM loop.
 */
export function shouldWarnProviderMismatch(total: number, notAnEntity: number): boolean {
    return total >= MISMATCH_MIN_ENTITIES && notAnEntity / total >= MISMATCH_RATIO;
}

/** The per-entity character/world log kinds the seed digest surfaces. */
const DIGEST_KINDS = [
    { key: 'character_log', label: 'character' },
    { key: 'world_log', label: 'world' },
] as const;

/** Action union — the read-only catalog plus this agent's two terminals. */
type PerEntityAction =
    | ReadOnlyAction
    | { action: typeof COMMIT_ENTITY_STATE_REVIEW; args: unknown; callId?: string }
    | { action: typeof REPORT_NOT_AN_ENTITY; args: unknown; callId?: string };

/** Everything `buildSeedMessage` needs that's constant across this run's entities. */
interface SeedContext {
    targetFile: string;
    formatTemplate: string;
    fileList: string;
    timeSpan: { start: string; end: string };
    logDigest: string;
}

/**
 * Shared base for the two per-entity state agents
 * ({@link import('./character-state-agent').CharacterStateAgent} and
 * {@link import('./faction-state-agent').FactionStateAgent}). One LLM call per
 * entity — perspective can't be mixed across entities — run **sequentially**
 * (the base loop drives a single conversation off instance state, so parallel
 * entities would tread on each other; cloud parallelism is a later refactor).
 *
 * A {@link BaseEntityTriageAgent} runs first and narrows the roster to the
 * entities that actually need work this save; the per-entity loop only touches
 * that subset (triage degrades to "process all" on any failure).
 *
 * Per entity it runs Job A (fact verify / deepen against visible events) and
 * Job B (time-elapse evolution) in one prompt, ending in either
 * `commitEntityStateReview` (a per-entity hunk delta) or `reportNotAnEntity`
 * (the entry is a provider artifact, not a real entity). A failure degrades to
 * identity for THAT entity — the rest of the run proceeds — so the agent can
 * never sink a save.
 */
export abstract class BasePerEntityStateAgent extends BaseSaveSubAgent<PerEntityAction> implements AdvancedSaveAgent {
    abstract readonly i18nKey: string;

    /** Locale-resolved file this agent owns (character status / world factions). */
    protected abstract resolveTargetFile(cf: AppLocale['coreFilenames']): string;
    /** Provider call — `listCharacters` / `listFactions` adapted to the shared shape. */
    protected abstract listEntities(files: ReadonlyMap<string, string>): Awaitable<PerEntityState[]>;
    /** The triage agent that selects which entities to process (subclass-injected). */
    protected abstract readonly triage: BaseEntityTriageAgent;

    private i18n = inject(I18nService);

    /** Set by the terminal handler; consumed after each entity's loop. */
    private capturedCommit: CommitEntityStateReviewArgs | null = null;
    private capturedNotAnEntity: ReportNotAnEntityArgs | null = null;
    private toolsCache: LLMFunctionDeclaration[] | null = null;

    async process(input: AdvancedSaveAgentInput): Promise<SaveHunk[]> {
        const cf = getLocale(input.lang).coreFilenames;
        const targetFile = this.resolveTargetFile(cf);
        const entities = await this.listEntities(input.files);

        // Empty provider → a visible-by-default warning + skip. Aligns with the
        // "a failed advanced agent must degrade identity" rule — the other
        // agents on the chain are untouched.
        if (entities.length === 0) {
            const entryId = this.progress.startEntry('advanced-agent', { toolName: this.traceLabel });
            this.progress.setEntryWarnings(entryId, [this.i18n.translate(`${this.i18nKey}.emptyProvider`)]);
            this.progress.finishEntry(entryId, 'skipped', 'no_entities');
            return [...input.hunks];
        }

        const actMessages = sliceToActStart(input.chatMessages);
        const triageCtx: TriageSeedContext = {
            fileList: Array.from(input.files.keys()).map(f => `- ${f}`).join('\n'),
            timeSpan: extractActTimeSpan(actMessages),
            logDigest: renderActLogDigest(actMessages, [...DIGEST_KINDS]),
        };

        // Triage gate: process only the entities that need work this save. A
        // null decision (triage failed / returned no selection) means "process
        // all" — triage must never silently drop a background entity.
        const decisions = await this.triage.selectEntities(entities, targetFile, triageCtx, input);
        const reasonByName = new Map<string, string>();
        let toProcess = entities;
        if (decisions !== null) {
            const selected = new Set(decisions.map(d => d.name));
            toProcess = entities.filter(e => selected.has(e.name));
            for (const d of decisions) reasonByName.set(d.name, d.reason);
        }
        if (toProcess.length === 0) return [...input.hunks];

        await this.prepareRun();

        const seedCtx: SeedContext = {
            targetFile,
            formatTemplate: extractFormatTemplate(input.files.get(targetFile) ?? ''),
            fileList: triageCtx.fileList,
            timeSpan: triageCtx.timeSpan,
            logDigest: triageCtx.logDigest,
        };
        // newHunks may target any known entity's section, so the gate is the
        // full roster — not just the processed subset.
        const knownEntityNames = new Set(entities.map(e => e.name));
        const validMessageIds = new Set(input.chatMessages.map(m => m.id));

        let hunks = [...input.hunks];
        let notAnEntityCount = 0;

        // Sequential — one conversation at a time on the shared instance state.
        for (const entity of toProcess) {
            if (input.signal.aborted) throw makeAbortError();
            const outcome = await this.runEntity(
                entity, hunks, seedCtx, targetFile, knownEntityNames, validMessageIds, input,
                reasonByName.get(entity.name),
            );
            hunks = outcome.hunks;
            if (outcome.notAnEntity) notAnEntityCount++;
        }

        this.maybeWarnProviderMismatch(toProcess.length, notAnEntityCount, targetFile);
        return hunks;
    }

    // ===== Per-entity conversation =====

    private async runEntity(
        entity: PerEntityState,
        hunks: SaveHunk[],
        seedCtx: SeedContext,
        targetFile: string,
        knownEntityNames: ReadonlySet<string>,
        validMessageIds: ReadonlySet<string>,
        input: AdvancedSaveAgentInput,
        triageReason: string | undefined,
    ): Promise<{ hunks: SaveHunk[]; notAnEntity: boolean }> {
        const entryId = this.progress.startEntry('advanced-agent', {
            toolName: this.traceLabel,
            entityName: entity.name,
        });
        this.capturedCommit = null;
        this.capturedNotAnEntity = null;

        const ok = await this.runConversation(
            this.buildSeedMessage(entity, hunks, seedCtx, targetFile, triageReason), entryId, input, true,
        );
        if (!ok) return { hunks, notAnEntity: false };

        // Cast widens past TS's control-flow narrowing — the terminal handler
        // assigns these via a callback path inside processAgentTurn that TS
        // doesn't track, so the `= null` resets above would otherwise narrow
        // them to `never`.
        const notAnEntity = this.capturedNotAnEntity as ReportNotAnEntityArgs | null;
        if (notAnEntity) {
            this.progress.setEntryLogs(entryId, this.agentLogs());
            this.progress.finishEntry(entryId, 'skipped', `not_an_entity: ${notAnEntity.reason}`);
            return { hunks, notAnEntity: true };
        }

        const commit = this.capturedCommit as CommitEntityStateReviewArgs | null;
        if (commit === null) {
            this.progress.finishEntry(entryId, 'done', 'no changes');
            return { hunks, notAnEntity: false };
        }
        const scope = { targetFile, currentEntityName: entity.name, knownEntityNames };
        const { hunks: nextHunks, warnings } = applyEntityStateReview(hunks, commit, scope, validMessageIds);
        if (warnings.length) {
            console.warn(`[${this.traceLabel}] skipped inputs for "${entity.name}":`, warnings.join('; '));
            this.progress.setEntryWarnings(entryId, warnings);
        }
        this.progress.setEntryLogs(entryId, this.agentLogs());
        this.progress.finishEntry(entryId, 'done', commit.summary || 'entity state review committed');
        return { hunks: nextHunks, notAnEntity: false };
    }

    /** If most entries came back as non-entities, surface a format-mismatch banner. */
    private maybeWarnProviderMismatch(total: number, skipped: number, targetFile: string): void {
        if (!shouldWarnProviderMismatch(total, skipped)) return;
        const entryId = this.progress.startEntry('advanced-agent', { toolName: this.traceLabel });
        this.progress.setEntryWarnings(entryId, [
            this.i18n.translate(`${this.i18nKey}.providerMismatchSuspected`, {
                skipped, total, file: targetFile,
            }),
        ]);
        this.progress.finishEntry(entryId, 'done', 'provider mismatch suspected');
    }

    // ===== BaseToolCallAgent / ReadOnlyAgent overrides =====

    protected override get tools(): LLMFunctionDeclaration[] {
        return (this.toolsCache ??= [
            ...super.tools,
            COMMIT_ENTITY_STATE_REVIEW_TOOL,
            REPORT_NOT_AN_ENTITY_TOOL,
        ]);
    }

    protected override isTerminal(action: PerEntityAction): boolean {
        return action.action === COMMIT_ENTITY_STATE_REVIEW || action.action === REPORT_NOT_AN_ENTITY;
    }

    protected override dispatchTool(
        action: PerEntityAction, context: ReadOnlyAgentContext,
    ): Awaitable<ToolExecutionResult> {
        const read = this.dispatchReadTool(action, context);
        if (read !== null) return read;
        // The two terminals never route through here.
        return { response: { error: `Unknown action: ${action.action}` } };
    }

    /** Capture whichever terminal fired, then stop the loop. */
    protected override async handleTerminalAction(
        _context: ReadOnlyAgentContext,
        terminalAction: PerEntityAction,
        _mode: 'native' | 'json',
        ctx: TurnContext,
    ): Promise<void> {
        if (terminalAction.action === REPORT_NOT_AN_ENTITY) {
            this.capturedNotAnEntity = parseReportNotAnEntityArgs(terminalAction.args);
            const reason = this.capturedNotAnEntity.reason || '(unspecified)';
            this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: `not an entity: ${reason}`, isToolCall: false }));
        } else {
            this.capturedCommit = parseCommitEntityStateArgs(terminalAction.args);
            const summary = this.capturedCommit.summary || '(entity review committed)';
            this.updateLogAt(ctx.currentLogIndex, e => ({ ...e, text: summary, isToolCall: false }));
        }
        this.isAgentRunning.set(false);
    }

    // ===== Internals =====

    private buildSeedMessage(
        entity: PerEntityState, hunks: readonly SaveHunk[], ctx: SeedContext, targetFile: string,
        triageReason: string | undefined,
    ): string {
        const entityHunks = hunks
            .filter(h => h.file === targetFile && h.context.includes(entity.name))
            .map(h => ({
                id: h.id,
                file: h.file,
                context: h.context,
                target: h.target,
                replacement: h.replacement,
                sourceMessageIds: h.sourceMessageIds,
            }));

        const parts: string[] = [
            `Review the single entity below in "${targetFile}". Run Job A (verify / deepen its hunks against `
                + `visible events) and Job B (time-elapse evolution), then call exactly one of `
                + `${COMMIT_ENTITY_STATE_REVIEW} or ${REPORT_NOT_AN_ENTITY}.`,
            '',
            'Available KB files:',
            ctx.fileList,
        ];

        if (triageReason) {
            parts.push('', `[TRIAGE NOTE] — why the triage step flagged this entity (a lead, not a limit): ${triageReason}`);
        }

        if (ctx.formatTemplate) {
            parts.push('', '[FORMAT TEMPLATE] — write revise / new hunks to match this entry shape:', '```markdown', ctx.formatTemplate, '```');
        }

        parts.push(
            '',
            `[ENTITY CARD] — ${entity.headingPath}`,
            '```markdown',
            entity.rawText,
            '```',
            '',
            "[HUNKS FOR THIS ENTITY] — the SaveAgent's hunks already targeting this entity:",
            '```json',
            JSON.stringify(entityHunks, null, 2),
            '```',
            '',
            `[ACT TIMESPAN] start: ${ctx.timeSpan.start || '(unknown)'} | end: ${ctx.timeSpan.end || '(unknown)'}`,
            '',
            "[ACT LOG DIGEST] — this ACT's character_log + world_log, by message id:",
            '```',
            ctx.logDigest,
            '```',
        );
        return parts.join('\n');
    }
}

/**
 * Derive the ACT's time window from the first and last model message that
 * carries a scene header. Empty strings when none — the prompt treats an
 * unknown span as "use your judgement", so absence is not an error.
 */
function extractActTimeSpan(actMessages: readonly ChatMessage[]): { start: string; end: string } {
    const headers: string[] = [];
    for (const m of actMessages) {
        if (m.role !== 'model') continue;
        const h = extractSceneHeader(m.content).trim();
        if (h) headers.push(h);
    }
    return { start: headers[0] ?? '', end: headers[headers.length - 1] ?? '' };
}
