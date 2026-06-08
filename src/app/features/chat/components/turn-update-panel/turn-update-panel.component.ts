import { Component, inject, computed, output, viewChild, ElementRef, input, effect } from '@angular/core';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { CORE_MAT } from '@app/shared/material/material-groups';
import { StatsViewService } from '@app/core/services/stats/stats-view.service';
import { buildStatChips, StatChip } from '@app/core/services/stats/stats-chip.util';
import { StatChipListComponent } from '../stat-chip-list/stat-chip-list.component';

@Component({
    selector: 'app-turn-update-panel',
    standalone: true,
    imports: [
        ...CORE_MAT,
        TranslatePipe,
        StatChipListComponent
    ],
    templateUrl: './turn-update-panel.component.html',
    styleUrl: './turn-update-panel.component.scss'
})
export class TurnUpdatePanelComponent {
    engine = inject(GameEngineService);
    state = inject(GameStateService);
    private statsView = inject(StatsViewService);
    private i18n = inject(I18nService);

    isOpen = input<boolean>(false);
    closePanel = output<void>();
    jumpToMessage = output<string>();

    contentContainer = viewChild<ElementRef<HTMLDivElement>>('contentContainer');

    // Track previous isOpen state with a simple boolean (not linkedSignal which syncs automatically)
    private wasOpen = false;

    updates = computed(() => {
        return this.state.messages().filter(m =>
            (m.summary || (m.character_log && m.character_log.length > 0) || (m.inventory_log && m.inventory_log.length > 0) || (m.quest_log && m.quest_log.length > 0) || (m.world_log && m.world_log.length > 0) || !!m.correction || !!this.statsView.appliedForMessage(m.id)) &&
            !m.isRefOnly
        );
    });

    /**
     * Per-message stat chips for the panel cards, keyed by message id — only
     * messages that actually changed a stat get an entry. Mirrors the inline turn
     * view via the shared {@link buildStatChips} builder so the two never diverge.
     */
    statChips = computed<Map<string, StatChip[]>>(() => {
        const out = new Map<string, StatChip[]>();
        const eventTooltip = this.i18n.translate('ui.STAT_EVENT_TOOLTIP');
        const droppedPrefix = this.i18n.translate('ui.STAT_CHIP_DROPPED_PREFIX');
        for (const m of this.updates()) {
            const view = this.statsView.appliedForMessage(m.id);
            if (view) {
                out.set(m.id, buildStatChips(view.applied, view.triggered, {
                    eventTooltip,
                    droppedPrefix,
                    colorFor: key => this.statsView.colorFor(key),
                }));
            }
        }
        return out;
    });

    constructor() {
        // Scroll to bottom when panel opens (transition from closed to open)
        effect(() => {
            const open = this.isOpen();

            if (open && !this.wasOpen) {
                // Panel just opened - scroll to bottom
                const el = this.contentContainer()?.nativeElement;
                if (el) {
                    setTimeout(() => {
                        el.scrollTop = el.scrollHeight;
                    }, 100);
                }
            }

            // Update previous state after checking
            this.wasOpen = open;
        });
    }

    formatTime(timestamp?: number): string {
        if (!timestamp) return '';
        return new Date(timestamp).toLocaleTimeString();
    }

    onJump(id: string) {
        this.jumpToMessage.emit(id);
    }
}
