import { Component, computed, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatChipsModule } from '@angular/material/chips';
import { CORE_MAT, DIALOG_MAT, PROGRESS_MAT } from '@app/shared/material/material-groups';
import { TranslatePipe } from '@app/core/i18n';
import { SaveProgressTracker } from '@app/core/services/multi-agent-save/progress/save-progress-tracker.service';
import type { SaveProgressEntry } from '@app/core/services/multi-agent-save/multi-agent-save.types';
import { AutoScrollBottomDirective } from '@app/shared/directives/auto-scroll-bottom.directive';
import {
    AgentTraceSurfaceComponent,
    type AgentLogFoldKey,
} from '@app/shared/components/agent-trace-surface/agent-trace-surface.component';

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

    readonly totalUsage = computed(() => this.tracker.totalUsage());

    /**
     * Cancel button visible only while the save work is actively running.
     * Once `workComplete` flips true, the Close button takes over — the
     * orchestrator may still be holding `isRunning` (paused review,
     * AutoUpdate handoff), but there's nothing left to abort.
     */
    readonly canCancel = computed(() => this.isRunning() && !this.workComplete());

    cancel(): void {
        this.data.abortController.abort();
    }

    close(): void {
        this.dialogRef.close();
    }

    /** PP progress as a percentage 0-100 for `<mat-progress-bar [value]>`. */
    ppPercent(entry: SaveProgressEntry): number {
        return Math.round((entry.ppProgress ?? 0) * 100);
    }

    /**
     * Surface-emitted fold click for one of the entry's structured log
     * entries. The tracker owns its own snapshot of `logs` (set by the
     * agent's mirror effect) — toggling here mutates only the dialog's
     * view; we don't reach back into the agent's signal. While the agent
     * is still streaming, the next mirror tick will overwrite the toggle.
     * After the run finishes (no more mirrors), folds persist.
     */
    onTraceFoldToggle(entry: SaveProgressEntry, evt: { index: number; key: AgentLogFoldKey }): void {
        const logs = entry.logs;
        if (!logs) return;
        const target = logs[evt.index];
        if (!target) return;
        const next = logs.slice();
        next[evt.index] = { ...target, [evt.key]: !target[evt.key] };
        this.tracker.setEntryLogs(entry.entryId, next);
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
}
