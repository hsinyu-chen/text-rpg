import { Component, computed, inject, signal } from '@angular/core';
import { Clipboard } from '@angular/cdk/clipboard';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatChipsModule } from '@angular/material/chips';
import { MatSnackBar } from '@angular/material/snack-bar';
import { CORE_MAT, DIALOG_MAT, PROGRESS_MAT } from '@app/shared/material/material-groups';
import { TranslatePipe, I18nService } from '@app/core/i18n';
import { formatAgentDebugLog } from '@app/core/utils/format-agent-debug-log';
import { SaveProgressTracker } from '@app/core/services/multi-agent-save/progress/save-progress-tracker.service';
import type { SaveProgressEntry } from '@app/core/services/multi-agent-save/multi-agent-save.types';
import { AutoScrollBottomDirective } from '@app/shared/directives/auto-scroll-bottom.directive';
import { AgentTraceSurfaceComponent } from '@app/shared/components/agent-trace-surface/agent-trace-surface.component';

/**
 * Modal dialog rendered for the duration of one multi-agent save run.
 *
 * Reads append-only from {@link SaveProgressTracker} — every entry is a
 * card; streaming chunks (thought / output / pp / usage) update the card
 * in place as the corresponding LLM call / mechanical handler runs.
 *
 * Phase 1 scope:
 * - Per-entry cards with state badge, optional PP progress bar, optional
 *   CoT details panel, optional structured-output `<pre>`, optional token
 *   usage line.
 * - Footer: total token usage across entries + Cancel button.
 * - No inspect-mode "next step" gating (deferred).
 *
 * Cancel-button wiring: the orchestrator passes its `AbortController` via
 * dialog data so the dialog can abort the in-flight LLM call without
 * needing to know orchestrator internals.
 */
export interface SaveProgressDialogData {
    abortController: AbortController;
}

@Component({
    selector: 'app-save-progress-dialog',
    standalone: true,
    imports: [
        ...CORE_MAT,
        ...DIALOG_MAT,
        ...PROGRESS_MAT,
        MatExpansionModule,
        MatChipsModule,
        TranslatePipe,
        AutoScrollBottomDirective,
        AgentTraceSurfaceComponent,
    ],
    templateUrl: './save-progress-dialog.component.html',
    styleUrl: './save-progress-dialog.component.scss',
})
export class SaveProgressDialogComponent {
    private dialogRef = inject(MatDialogRef<SaveProgressDialogComponent>);
    private tracker = inject(SaveProgressTracker);
    private clipboard = inject(Clipboard);
    private snackBar = inject(MatSnackBar);
    private i18n = inject(I18nService);
    /**
     * Abort source supplied by the orchestrator at open time via
     * MAT_DIALOG_DATA — declarative dependency, no temporal coupling
     * around when `attachAbort` is called. Non-null from construction,
     * so `canCancel` only needs to track the isRunning signal.
     */
    private data = inject<SaveProgressDialogData>(MAT_DIALOG_DATA);

    readonly entries = this.tracker.entries;
    readonly isRunning = this.tracker.isRunning;
    readonly workComplete = this.tracker.workComplete;
    readonly hasUpdates = this.tracker.hasUpdates;

    readonly totalUsage = computed(() => this.tracker.totalUsage());

    /**
     * Cancel button visible only while the save work is actively running.
     * Once `workComplete` flips true, the Close / Continue pair takes over —
     * the orchestrator may still be holding `isRunning` (paused review,
     * AutoUpdate handoff), but there's nothing left to abort.
     */
    readonly canCancel = computed(() => this.isRunning() && !this.workComplete());

    /**
     * Continue button visible only when work finished AND produced
     * applyable updates. Clicking it closes the dialog with `true` so the
     * orchestrator advances into AutoUpdateDialog; Close closes with the
     * default `undefined` (falsy) so the orchestrator skips the handoff.
     */
    readonly canContinue = computed(() => this.workComplete() && this.hasUpdates());

    cancel(): void {
        this.data.abortController.abort();
    }

    close(): void {
        this.dialogRef.close(false);
    }

    continueToAutoUpdate(): void {
        this.dialogRef.close(true);
    }

    /** PP progress as a percentage 0-100 for `<mat-progress-bar [value]>`. */
    ppPercent(entry: SaveProgressEntry): number {
        return Math.round((entry.ppProgress ?? 0) * 100);
    }

    /**
     * Per-entry expand override for the panel and the CoT `<details>`,
     * scoped to the state the user set it in. `state === 'running'` is the
     * default (auto-open while working, auto-collapse once done) — but binding
     * that reactively re-applies it every change-detection, so a manual
     * collapse mid-run snaps back open. These overrides win while the entry
     * stays in the same state; on a state transition the override lapses and
     * the default applies once more.
     */
    private panelOverride = signal<ReadonlyMap<string, { state: SaveProgressEntry['state']; expanded: boolean }>>(new Map());
    private cotOverride = signal<ReadonlyMap<string, { state: SaveProgressEntry['state']; open: boolean }>>(new Map());

    protected isPanelExpanded(entry: SaveProgressEntry): boolean {
        const o = this.panelOverride().get(entry.entryId);
        return o && o.state === entry.state ? o.expanded : entry.state === 'running';
    }

    protected onPanelToggle(entry: SaveProgressEntry, expanded: boolean): void {
        this.panelOverride.update(m => new Map(m).set(entry.entryId, { state: entry.state, expanded }));
    }

    protected isCotOpen(entry: SaveProgressEntry): boolean {
        const o = this.cotOverride().get(entry.entryId);
        return o && o.state === entry.state ? o.open : entry.state === 'running';
    }

    protected onCotToggle(entry: SaveProgressEntry, ev: Event): void {
        const open = (ev.target as HTMLDetailsElement).open;
        this.cotOverride.update(m => new Map(m).set(entry.entryId, { state: entry.state, open }));
    }

    /** Whether an entry carries anything worth copying (trace / output / CoT). */
    hasDebug(entry: SaveProgressEntry): boolean {
        return !!(entry.logs?.length || entry.output || entry.thought);
    }

    /**
     * Copies one entry's trace to the clipboard in the same plain-text format
     * the file-agent console's copy-debug button uses ({@link formatAgentDebugLog})
     * — the per-card analogue, so a tester can grab a single agent's run (e.g. a
     * triage card) and paste it verbatim. Stops propagation so the header click
     * doesn't also toggle the panel.
     */
    copyEntryDebug(entry: SaveProgressEntry, event: MouseEvent): void {
        event.stopPropagation();
        this.clipboard.copy(this.buildEntryDebug(entry));
        this.snackBar.open(this.i18n.translate('multiAgentSave.progress.debugCopied'), undefined, { duration: 1500 });
    }

    /** Render one entry as the shared debug-log text. Structured-trace entries
     *  go through {@link formatAgentDebugLog}; an output-only entry (e.g. the
     *  SaveAgent's manifest, which has no `logs`) falls back to its CoT + output. */
    private buildEntryDebug(entry: SaveProgressEntry): string {
        const title = entry.entityName ? `${entry.toolName ?? entry.phase} — ${entry.entityName}` : (entry.toolName ?? entry.phase);
        if (entry.logs?.length) {
            return formatAgentDebugLog([{ title, logs: entry.logs }]);
        }
        const parts = [`=== ${title} ===`];
        if (entry.thought) parts.push('', '<thinking>', entry.thought, '</thinking>');
        if (entry.output) parts.push('', entry.output);
        return parts.join('\n');
    }

    /** Material icon for each entry state — keeps the template free of icon-mapping logic. */
    stateIcon(state: SaveProgressEntry['state']): string {
        switch (state) {
            case 'running': return 'hourglass_top';
            case 'retry':   return 'refresh';
            case 'done':    return 'check_circle';
            case 'skipped': return 'remove_circle_outline';
            case 'failed':  return 'error';
        }
    }

    /**
     * Done/total count for the checklist header above the expanded TODO list.
     * Null when the entry has no `updateTodos` checklist, or when it ended on
     * `skipped` / `failed` — those surface their `statusReason` instead. On
     * `done` the count is forced to total/total (e.g. 5/5) so it reads complete
     * without the agent having to tick the final item.
     */
    todoCount(entry: SaveProgressEntry): { done: number; total: number } | null {
        const todos = entry.todos;
        if (!todos?.length) return null;
        if (entry.state !== 'running' && entry.state !== 'done') return null;
        const total = todos.length;
        return { done: entry.state === 'done' ? total : todos.filter(t => t.done).length, total };
    }
}
