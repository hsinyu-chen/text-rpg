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
import { ContentSanitizerPipe } from '@app/shared/pipes/content-sanitizer.pipe';
import { WrapSaveXmlPipe } from '@app/shared/pipes/wrap-save-xml.pipe';
import { ChatMessage } from '@app/core/models/types';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MessageStateService } from './message-state.service';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { TurnUpdateComponent } from '../turn-update/turn-update.component';
import { GAME_INTENTS } from '@app/core/constants/game-intents';
import { getIntentLabels, getUIStrings } from '@app/core/constants/engine-protocol';
import { getLocale } from '@app/core/constants/locales';
import { computed } from '@angular/core';
import { KATEX_DELIMITERS, hasKatexDelimiters } from '@app/core/utils/latex.util';

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
        ContentSanitizerPipe,
        WrapSaveXmlPipe,
        MatProgressSpinnerModule,
        MatProgressBarModule,
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
    gameState = inject(GameStateService);
    private appConfig = inject(AppConfigStore);

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

    // Localized strings
    locale = computed(() => getLocale(this.appConfig.outputLanguage()));
    intentLabels = computed(() => getIntentLabels(this.appConfig.outputLanguage()));
    idealOutcomeChipPrefix = computed(() => getUIStrings(this.appConfig.outputLanguage()).IDEAL_OUTCOME_CHIP_PREFIX);

    // Prefill Metrics
    prefillSpeed = computed(() => {
        const usage = this.message().usage;
        if (!usage || !usage.promptSpeed) return null;
        return usage.promptSpeed;
    });

    prefillETA = computed(() => {
        const usage = this.message().usage;
        if (!usage || !usage.promptTotal || !usage.promptProcessed || !usage.promptSpeed) return null;

        const remaining = usage.promptTotal - usage.promptProcessed;
        if (remaining <= 0) return null;

        const seconds = Math.ceil(remaining / usage.promptSpeed);

        if (seconds > 60) {
            const m = Math.floor(seconds / 60);
            const s = seconds % 60;
            return `${m}m ${s}s`;
        }
        return `${seconds}s`;
    });

    // Conditional KaTeX: skip expensive DOM scan when no math delimiters present
    contentHasKatex = computed(() => hasKatexDelimiters(this.message()?.content));
    thoughtHasKatex = computed(() => hasKatexDelimiters(this.message()?.thought));
    analysisHasKatex = computed(() => hasKatexDelimiters(this.message()?.analysis));

    katexOptions = { delimiters: KATEX_DELIMITERS };

    getIntentLabel(intent: string | undefined): string {
        if (!intent) return '';
        const labels = this.intentLabels();
        // Map intent values to label keys
        if (intent === GAME_INTENTS.ACTION) return labels.ACTION;
        if (intent === GAME_INTENTS.FAST_FORWARD) return labels.FAST_FORWARD;
        if (intent === GAME_INTENTS.SYSTEM) return labels.SYSTEM;
        if (intent === GAME_INTENTS.SAVE) return labels.SAVE;
        if (intent === GAME_INTENTS.CONTINUE) return labels.CONTINUE;
        return intent; // Fallback to raw value
    }

    onEditAndResend() {
        this.resend.emit(this.message());
    }

}
