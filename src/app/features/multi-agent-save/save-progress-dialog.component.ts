import { Component, computed, inject, signal } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatChipsModule } from '@angular/material/chips';
import { CORE_MAT, DIALOG_MAT, PROGRESS_MAT } from '@app/shared/material/material-groups';
import { TranslatePipe } from '@app/core/i18n';
import { SaveProgressTracker } from '@app/core/services/multi-agent-save/progress/save-progress-tracker.service';
import type { SaveProgressEntry } from '@app/core/services/multi-agent-save/multi-agent-save.types';
import { AutoScrollBottomDirective } from './auto-scroll-bottom.directive';

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
    ],
    templateUrl: './save-progress-dialog.component.html',
    styleUrl: './save-progress-dialog.component.scss',
})
export class SaveProgressDialogComponent {
    private dialogRef = inject(MatDialogRef<SaveProgressDialogComponent>);
    private tracker = inject(SaveProgressTracker);

    /**
     * Optional abort signal source — orchestrator passes its controller via
     * `dialog.componentInstance.attachAbort()` after opening, so the dialog
     * doesn't depend on the orchestrator existing at construction time.
     *
     * Held in a signal so `canCancel`'s computed actually re-runs when
     * `attachAbort` fires (a plain class field doesn't notify dependents).
     */
    private abortController = signal<AbortController | null>(null);

    readonly entries = this.tracker.entries;
    readonly isRunning = this.tracker.isRunning;

    readonly totalUsage = computed(() => this.tracker.totalUsage());

    readonly canCancel = computed(() => this.isRunning() && this.abortController() !== null);

    attachAbort(controller: AbortController): void {
        this.abortController.set(controller);
    }

    cancel(): void {
        this.abortController()?.abort();
    }

    close(): void {
        this.dialogRef.close();
    }

    /** PP progress as a percentage 0-100 for `<mat-progress-bar [value]>`. */
    ppPercent(entry: SaveProgressEntry): number {
        return Math.round((entry.ppProgress ?? 0) * 100);
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
