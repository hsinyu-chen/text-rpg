import { Component, input, output, ChangeDetectionStrategy, inject, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MarkdownModule } from 'ngx-markdown';
import { TextFieldModule } from '@angular/cdk/text-field';
import { StripIntentPipe } from '../../../../shared/pipes/strip-intent.pipe';
import { ChatMessage } from '../../../../core/models/types';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MessageStateService } from './message-state.service';
import { GameEngineService } from '../../../../core/services/game-engine.service';
import { TurnUpdateComponent } from '../turn-update/turn-update.component';
import { GAME_INTENTS } from '../../../../core/constants/game-intents';
import { getIntentLabels } from '../../../../core/constants/engine-protocol';
import { computed } from '@angular/core';

@Component({
    selector: 'app-chat-message',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatButtonModule,
        MatIconModule,
        MatInputModule,
        MatFormFieldModule,
        MatTooltipModule,
        MarkdownModule,
        TextFieldModule,
        StripIntentPipe,
        MatProgressSpinnerModule,
        TurnUpdateComponent
    ],
    templateUrl: './chat-message.component.html',
    styleUrl: './chat-message.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    providers: [MessageStateService]
})
export class ChatMessageComponent {
    // Services
    state = inject(MessageStateService);
    engine = inject(GameEngineService);

    protected readonly Intents = GAME_INTENTS;

    // Inputs
    message = input.required<ChatMessage>();
    index = input.required<number>();
    isBusy = input<boolean>(false);
    isLastUser = input<boolean>(false);

    // Outputs
    resend = output<ChatMessage>();

    constructor() {
        // Sync inputs to service state
        effect(() => {
            this.state.message.set(this.message());
        });
        effect(() => {
            this.state.index.set(this.index());
        });
    }

    // Localized intent labels
    intentLabels = computed(() => getIntentLabels(this.engine.config()?.outputLanguage));

    getIntentLabel(intent: string | undefined): string {
        if (!intent) return '';
        const labels = this.intentLabels();
        // Map intent values to label keys
        if (intent.includes('行動')) return labels.ACTION;
        if (intent.includes('快轉') || intent.includes('快进')) return labels.FAST_FORWARD;
        if (intent.includes('系統') || intent.includes('系统')) return labels.SYSTEM;
        if (intent.includes('存檔') || intent.includes('存档')) return labels.SAVE;
        if (intent.includes('繼續') || intent.includes('继续')) return labels.CONTINUE;
        return intent; // Fallback to raw value
    }

    onEditAndResend() {
        this.resend.emit(this.message());
    }
}
