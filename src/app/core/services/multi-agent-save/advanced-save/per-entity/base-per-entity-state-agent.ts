import { inject, signal } from '@angular/core';
import type { LLMFunctionDeclaration, LLMProvider, LLMProviderConfig } from '@hcs/llm-core';
import type { ChatMessage } from '@app/core/models/types';
import { getLocale } from '@app/core/constants/locales';
import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import { DEFAULT_PROFILE_ID } from '@app/core/constants/prompt-profiles';
import { extractSceneHeader } from '@app/core/utils/scene-header.util';
import { LLMConfigService } from '../../../llm-config.service';
import { LLMProviderRegistryService } from '../../../llm-provider-registry.service';
import { InjectionService, type PromptType } from '../../../injection.service';
import { GameStateService } from '../../../game-state.service';
import { I18nService } from '../../../../i18n/i18n.service';
import { ReadOnlyAgent, type ReadOnlyAgentContext } from '../../../agent-runner/read-only-agent';
import type { TurnSetup, TurnContext } from '../../../agent-runner/base-tool-call-agent';
import type { Awaitable, ReadOnlyAction, ToolExecutionResult } from '../../../agent-runner/agent-runner.types';
import type { SaveHunk } from '../../multi-agent-save.types';
import { SaveSettingsStore } from '../../save-settings.store';
import { SaveProgressTracker } from '../../progress/save-progress-tracker.service';
import { installAgentProgressMirrors } from '../../progress/agent-progress-mirror.util';
import { sliceToActStart, renderActLogDigest } from '../../utils/act-window.util';
import { makeAbortError } from '../../utils/abort-error.util';
import { extractFormatTemplate } from '../../utils/extract-format-template.util';
import { resolveAutoToolCallMode } from '../../utils/resolve-tool-call-mode.util';
import type { AdvancedSaveAgent, AdvancedSaveAgentInput } from '../advanced-save-agent';
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
 * {@link import('./faction-state-agent').FactionStateAgent}). One LLM call
 * per entity — perspective can't be mixed across entities — run **sequentially**
 * (the base {@link ReadOnlyAgent} loop drives a single conversation off instance
 * state, so parallel entities would tread on each other; cloud parallelism is a
 * Phase 2 refactor).
 *
 * Per entity it runs Job A (fact verify / deepen against visible events) and
 * Job B (time-elapse evolution) in one prompt, ending in either
 * `commitEntityStateReview` (a per-entity hunk delta) or `reportNotAnEntity`
 * (the entry is a provider artifact, not a real entity). A failure degrades to
 * identity for THAT entity — the rest of the run proceeds — so the agent can
 * never sink a save.
 */
export abstract class BasePerEntityStateAgent extends ReadOnlyAgent<PerEntityAction> implements AdvancedSaveAgent {
    abstract readonly id: string;
    abstract readonly i18nKey: string;
    /** The prompt registered with {@link InjectionService} for this agent. */
    protected abstract readonly promptType: PromptType;
    /** Trace-card label, e.g. `CharacterStateAgent`. */
    protected abstract readonly traceLabel: string;

    /** Locale-resolved file this agent owns (character status / world factions). */
    protected abstract resolveTargetFile(cf: AppLocale['coreFilenames']): string;
    /** Provider call — `listCharacters` / `listFactions` adapted to the shared shape. */
    protected abstract listEntities(files: ReadonlyMap<string, string>): Awaitable<PerEntityState[]>;

    private llmConfig = inject(LLMConfigService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private injection = inject(InjectionService);
    private gameState = inject(GameStateService);
    private saveSettings = inject(SaveSettingsStore);
    private progress = inject(SaveProgressTracker);
    private i18n = inject(I18nService);

    /** Save sub-step — a tighter budget than the file-agent's interactive loop. */
    protected override readonly maxTurns = 30;

    /** Loaded once per run; resolved provider + tool-call mode reused across entities. */
    private systemPrompt = '';
    private resolvedProvider: { provider: LLMProvider; config: LLMProviderConfig } | null = null;
    private toolCallMode: 'native' | 'json' = 'json';
    /** Set by the terminal handler; consumed after each entity's loop. */
    private capturedCommit: CommitEntityStateReviewArgs | null = null;
    private capturedNotAnEntity: ReportNotAnEntityArgs | null = null;
    /** Active progress entry id — a signal so the PP/log mirror effects re-fire on swap. */
    private activeEntryId = signal<string | null>(null);
    private toolsCache: LLMFunctionDeclaration[] | null = null;

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

        this.systemPrompt = await this.loadPrompt();
        this.resolvedProvider = this.resolveProvider();
        this.toolCallMode = this.resolvedProvider
            ? await resolveAutoToolCallMode(this.resolvedProvider.provider, this.resolvedProvider.config)
            : 'json';

        const actMessages = sliceToActStart(input.chatMessages);
        const seedCtx: SeedContext = {
            targetFile,
            formatTemplate: extractFormatTemplate(input.files.get(targetFile) ?? ''),
            fileList: Array.from(input.files.keys()).map(f => `- ${f}`).join('\n'),
            timeSpan: extractActTimeSpan(actMessages),
            logDigest: renderActLogDigest(actMessages, [...DIGEST_KINDS]),
        };
        const knownEntityNames = new Set(entities.map(e => e.name));
        const validMessageIds = new Set(input.chatMessages.map(m => m.id));

        let hunks = [...input.hunks];
        let notAnEntityCount = 0;

        // Sequential — one conversation at a time on the shared instance state.
        for (const entity of entities) {
            if (input.signal.aborted) throw makeAbortError();
            const outcome = await this.runEntity(
                entity, hunks, seedCtx, targetFile, knownEntityNames, validMessageIds, input,
            );
            hunks = outcome.hunks;
            if (outcome.notAnEntity) notAnEntityCount++;
        }

        this.maybeWarnProviderMismatch(entities.length, notAnEntityCount, targetFile);
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
    ): Promise<{ hunks: SaveHunk[]; notAnEntity: boolean }> {
        const entryId = this.progress.startEntry('advanced-agent', {
            toolName: this.traceLabel,
            entityName: entity.name,
        });
        // Reset per-entity loop state BEFORE swapping the entry id — both mirror
        // effects fire the instant `activeEntryId` swaps, so a stale PP / log
        // from the previous entity must not stamp onto this card.
        this.promptProgress.set(undefined);
        this.agentLogs.set([]);
        this.todoList.set([]);
        this.activeEntryId.set(entryId);
        this.capturedCommit = null;
        this.capturedNotAnEntity = null;

        // Bridge the save run's abort into a fresh per-entity controller. Capture
        // it in a local so a late-firing listener aborts THIS entity's run, not a
        // later entity that reassigned `this.abortController`.
        const agentController = new AbortController();
        this.abortController = agentController;
        const abortHandler = (): void => agentController.abort();
        if (input.signal.aborted) agentController.abort();
        else input.signal.addEventListener('abort', abortHandler, { once: true });

        try {
            this.agentHistory.set([{
                role: 'user',
                parts: [{ text: this.buildSeedMessage(entity, hunks, seedCtx, targetFile) }],
            }]);
            this.isAgentRunning.set(true);
            await this.processAgentTurn({ files: input.files, chatMessages: input.chatMessages });
        } catch (err: unknown) {
            if (input.signal.aborted) {
                this.progress.skip(entryId, 'user_aborted');
                this.activeEntryId.set(null);
                throw err;
            }
            // Degrade to identity for THIS entity — the rest of the run proceeds.
            console.error(`[${this.traceLabel}] entity "${entity.name}" failed:`, err);
            this.progress.finishEntry(entryId, 'failed', err instanceof Error ? err.message : String(err));
            this.activeEntryId.set(null);
            return { hunks, notAnEntity: false };
        } finally {
            input.signal.removeEventListener('abort', abortHandler);
            this.isAgentRunning.set(false);
        }

        this.activeEntryId.set(null);
        if (input.signal.aborted) {
            this.progress.skip(entryId, 'user_aborted');
            throw makeAbortError();
        }

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

    protected override resolveTurnSetup(): TurnSetup | null {
        const resolved = this.resolvedProvider;
        if (!resolved) return null;
        const cap = resolved.provider.getCapabilities(resolved.config);
        const mode = this.toolCallMode;
        return {
            provider: resolved.provider,
            providerSettings: resolved.config as unknown as Record<string, unknown>,
            mode,
            allowParallel: false,
            systemInstruction: this.systemPrompt,
            genConfig: this.buildGenConfig(mode, cap.isLocalProvider),
        };
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

    private buildSeedMessage(
        entity: PerEntityState, hunks: readonly SaveHunk[], ctx: SeedContext, targetFile: string,
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
