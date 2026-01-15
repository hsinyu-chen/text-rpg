import { Component, inject, ChangeDetectionStrategy, input, linkedSignal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MessageStateService } from '../chat-message/message-state.service';
import { ChatMessage } from '../../../../core/models/types';

@Component({
    selector: 'app-turn-update',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatButtonModule,
        MatIconModule,
        MatTooltipModule
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
    message = input.required<ChatMessage>();

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
}
