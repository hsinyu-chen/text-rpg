import { Component, inject, ChangeDetectionStrategy, input } from '@angular/core';
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
}
