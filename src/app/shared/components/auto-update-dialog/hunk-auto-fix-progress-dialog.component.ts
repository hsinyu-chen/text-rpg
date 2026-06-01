import { Component, computed, inject, signal } from '@angular/core';
import { MatDialogModule, MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslatePipe } from '@app/core/i18n';
import type { LLMUsageMetadata } from '@hcs/llm-core';
import { AutoScrollBottomDirective } from '@app/shared/directives/auto-scroll-bottom.directive';

export interface HunkAutoFixProgressData {
    fileName: string;
    abortController: AbortController;
}

/**
 * Live progress view for one hunk auto-fix LLM call.
 *
 * The controller opens this dialog BEFORE the LLM call starts, hands its
 * `AbortController` in via data, and pushes streaming chunks via the
 * exposed `appendThought` / `appendOutput` / `setUsage` setters. When the
 * call resolves (success or fail), the controller closes the dialog — the
 * preview dialog (if any) opens after that, so the user never sees two
 * stacked modals.
 *
 * Kept as a per-call instance (not singleton) so concurrent fixes — should
 * we ever allow that — don't share state.
 */
@Component({
    selector: 'app-hunk-auto-fix-progress-dialog',
    standalone: true,
    imports: [MatDialogModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule, TranslatePipe, AutoScrollBottomDirective],
    templateUrl: './hunk-auto-fix-progress-dialog.component.html',
    styleUrl: './hunk-auto-fix-progress-dialog.component.scss',
})
export class HunkAutoFixProgressDialogComponent {
    private dialogRef = inject<MatDialogRef<HunkAutoFixProgressDialogComponent>>(MatDialogRef);
    readonly data = inject<HunkAutoFixProgressData>(MAT_DIALOG_DATA);

    readonly thought = signal('');
    readonly output = signal('');
    readonly usage = signal<LLMUsageMetadata | null>(null);
    /** Current retry round, surfaced so the user sees the loop re-prompting. */
    readonly round = signal(0);
    readonly maxRounds = signal(0);

    readonly hasThought = computed(() => this.thought().length > 0);
    readonly hasOutput = computed(() => this.output().length > 0);
    // Only surface from round 2 — round 1 isn't a "retry" yet.
    readonly showRounds = computed(() => this.round() > 1);

    /**
     * Mark the start of a repair round. The first round just records the
     * counters; later rounds also push a visual separator into the streams so
     * each round's reasoning/output stays delimited as they accumulate.
     */
    startRound(round: number, maxRounds: number): void {
        this.round.set(round);
        this.maxRounds.set(maxRounds);
        if (round > 1) {
            const divider = `\n\n──── retry ${round}/${maxRounds} ────\n\n`;
            if (this.thought()) this.thought.update(t => t + divider);
            if (this.output()) this.output.update(o => o + divider);
        }
    }

    appendThought(chunk: string): void {
        this.thought.update(t => t + chunk);
    }

    appendOutput(chunk: string): void {
        this.output.update(t => t + chunk);
    }

    setUsage(usage: LLMUsageMetadata): void {
        this.usage.set(usage);
    }

    cancel(): void {
        this.data.abortController.abort();
    }

    close(): void {
        this.dialogRef.close();
    }
}
