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
import { getLocale } from '@app/core/constants/locales';
import { I18nService } from '@app/core/i18n';
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
    private i18n = inject(I18nService);

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

    // Localized strings — engine-facing locale stays keyed by outputLanguage
    // (analysis trace markdown is persisted in the message); UI chrome flows
    // through i18n and tracks interfaceLanguage.
    locale = computed(() => getLocale(this.appConfig.outputLanguage()));
    idealOutcomeChipPrefix = computed(() => this.i18n.translate('ui.IDEAL_OUTCOME_CHIP_PREFIX'));

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
        const key = `intent.labels.${intent}`;
        const translated = this.i18n.translate(key);
        // Custom user intents have no dictionary entry — fall back to raw
        // value so the chip never renders the dotted key as text.
        return translated === key ? intent : translated;
    }

    onEditAndResend() {
        this.resend.emit(this.message());
    }

}
