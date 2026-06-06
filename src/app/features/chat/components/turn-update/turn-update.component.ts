import { Component, inject, ChangeDetectionStrategy, input, linkedSignal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { MessageStateService } from '../chat-message/message-state.service';
import { AutofocusSelectDirective } from '@app/shared/directives/autofocus-select.directive';
import { ChatMessage } from '@app/core/models/types';
import { AppliedDelta } from '@app/core/models/stats.types';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { StatsViewService } from '@app/core/services/stats/stats-view.service';
import { StatsStateDialogComponent } from '../stats-state-dialog/stats-state-dialog.component';

/** One rendered stat-change adornment for a model turn. */
interface StatChip {
    label: string;
    kind: 'gain' | 'loss' | 'neutral' | 'dropped' | 'event';
    tooltip: string;
    /** A stat's declared chip color (CSS string); overrides the gain/loss tint when set. */
    color?: string;
}

@Component({
    selector: 'app-turn-update',
    standalone: true,
    imports: [
        ...CORE_MAT,
        FormsModule,
        AutofocusSelectDirective,
        TranslatePipe
    ],
    templateUrl: './turn-update.component.html',
    styleUrl: './turn-update.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    host: {
        'style': 'display: block;'
    }
})
export class TurnUpdateComponent {
    state = inject(MessageStateService);
    private statsView = inject(StatsViewService);
    private dialog = inject(MatDialog);
    private i18n = inject(I18nService);
    message = input.required<ChatMessage>();

    /**
     * This turn's re-derived applied stat changes (post-clamp, with drops) plus
     * any triggered events, as chips. Empty unless the Book runs the numeric-stats
     * system and this turn changed a stat.
     */
    statChips = computed<StatChip[]>(() => {
        const view = this.statsView.appliedForMessage(this.message().id);
        if (!view) return [];
        const changes = view.applied.map(d => this.toStatChip(d));
        const events = view.triggered.map<StatChip>(trigger => ({
            label: trigger,
            kind: 'event',
            tooltip: this.i18n.translate('ui.STAT_EVENT_TOOLTIP')
        }));
        return [...changes, ...events];
    });

    /** Open the current full folded stat state in a dialog. */
    openStateViewer(): void {
        const state = this.statsView.currentState();
        if (!state) return;
        this.dialog.open(StatsStateDialogComponent, { data: state, width: '480px', maxWidth: '92vw' });
    }

    private toStatChip(d: AppliedDelta): StatChip {
        const target = d.field ? `${d.key}.${d.field}` : d.subkey ? `${d.key}.${d.subkey}` : d.key;
        if (d.dropped) {
            const requested = d.delta !== undefined ? this.signed(d.delta) : d.value !== undefined ? `=${d.value}` : '';
            return {
                label: requested ? `${target} ${requested}` : target,
                kind: 'dropped',
                tooltip: this.i18n.translate('ui.STAT_CHIP_DROPPED_PREFIX') + (d.warning ?? d.reason ?? '')
            };
        }
        const amount = d.after - d.before;
        return {
            label: `${target} ${this.signed(amount)}`,
            kind: amount > 0 ? 'gain' : amount < 0 ? 'loss' : 'neutral',
            tooltip: d.reason ?? '',
            color: this.statsView.colorFor(d.key)
        };
    }

    private signed(n: number): string {
        return n > 0 ? `+${n}` : `${n}`;
    }

    showInventory = linkedSignal({
        source: this.message,
        computation: (m) => (m.inventory_log?.length ?? 0) > 0
    });

    showQuest = linkedSignal({
        source: this.message,
        computation: (m) => (m.quest_log?.length ?? 0) > 0
    });

    showWorld = linkedSignal({
        source: this.message,
        computation: (m) => (m.world_log?.length ?? 0) > 0
    });

    showCharacter = linkedSignal({
        source: this.message,
        computation: (m) => (m.character_log?.length ?? 0) > 0
    });

    showCorrection = linkedSignal({
        source: this.message,
        computation: (m) => !!m.correction
    });

    // Default-open when this turn changed a stat — mirrors how the log sections
    // default-open when their log is non-empty.
    showStats = linkedSignal({
        source: this.message,
        computation: () => this.statChips().length > 0
    });
}
