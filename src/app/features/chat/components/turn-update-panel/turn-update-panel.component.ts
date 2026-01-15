import { Component, inject, computed, output, viewChild, ElementRef, input, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { GameEngineService } from '../../../../core/services/game-engine.service';
import { GameStateService } from '../../../../core/services/game-state.service';

@Component({
    selector: 'app-turn-update-panel',
    standalone: true,
    imports: [
        CommonModule,
        MatButtonModule,
        MatIconModule,
        MatTooltipModule
    ],
    templateUrl: './turn-update-panel.component.html',
    styleUrl: './turn-update-panel.component.scss'
})
export class TurnUpdatePanelComponent {
    engine = inject(GameEngineService);
    state = inject(GameStateService);

    isOpen = input<boolean>(false);
    closePanel = output<void>();
    jumpToMessage = output<string>();

    contentContainer = viewChild<ElementRef<HTMLDivElement>>('contentContainer');

    // Track previous isOpen state with a simple boolean (not linkedSignal which syncs automatically)
    private wasOpen = false;

    updates = computed(() => {
        return this.state.messages().filter(m =>
            (m.summary || (m.inventory_log && m.inventory_log.length > 0) || (m.quest_log && m.quest_log.length > 0) || (m.world_log && m.world_log.length > 0)) &&
            !m.isRefOnly
        );
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
