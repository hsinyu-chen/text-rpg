import { Component, inject, ChangeDetectionStrategy, input, linkedSignal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { MessageStateService } from '../chat-message/message-state.service';
import { AutofocusSelectDirective } from '@app/shared/directives/autofocus-select.directive';
import { ChatMessage } from '@app/core/models/types';
import { buildStatChips, StatChip } from '@app/core/services/stats/stats-chip.util';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { StatsViewService } from '@app/core/services/stats/stats-view.service';
import { StatsStateDialogComponent } from '../stats-state-dialog/stats-state-dialog.component';
import { StatChipListComponent } from '../stat-chip-list/stat-chip-list.component';

@Component({
    selector: 'app-turn-update',
    standalone: true,
    imports: [
        ...CORE_MAT,
        FormsModule,
        AutofocusSelectDirective,
        TranslatePipe,
        StatChipListComponent
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
        return buildStatChips(view.applied, view.triggered, {
            eventTooltip: this.i18n.translate('ui.STAT_EVENT_TOOLTIP'),
            droppedPrefix: this.i18n.translate('ui.STAT_CHIP_DROPPED_PREFIX'),
            colorFor: key => this.statsView.colorFor(key),
        });
    });

    /** Open the current full folded stat state in a dialog. */
    openStateViewer(): void {
        const state = this.statsView.currentState();
        if (!state) return;
        this.dialog.open(StatsStateDialogComponent, { data: state, width: '480px', maxWidth: '92vw' });
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
