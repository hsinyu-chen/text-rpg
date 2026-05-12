import { Component, inject, ChangeDetectionStrategy, input, linkedSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MessageStateService } from '../chat-message/message-state.service';
import { AutofocusSelectDirective } from '@app/shared/directives/autofocus-select.directive';
import { ChatMessage } from '@app/core/models/types';
import { TranslatePipe } from '@app/core/i18n';
import { CORE_MAT } from '@app/shared/material/material-groups';

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

    showCorrection = linkedSignal({
        source: this.message,
        computation: (m) => !!m.correction
    });
}
