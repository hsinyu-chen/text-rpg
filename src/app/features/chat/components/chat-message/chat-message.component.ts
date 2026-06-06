import { Component, input, output, ChangeDetectionStrategy, inject, effect } from '@angular/core';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MarkdownModule } from 'ngx-markdown';
import { TextFieldModule } from '@angular/cdk/text-field';
import { ContentSanitizerPipe } from '@app/shared/pipes/content-sanitizer.pipe';
import { ChatMessage } from '@app/core/models/types';
import { AppliedDelta } from '@app/core/models/stats.types';
import { CORE_MAT, PROGRESS_MAT } from '@app/shared/material/material-groups';
import { MessageStateService } from './message-state.service';
import { StatsViewService } from '@app/core/services/stats/stats-view.service';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { TurnUpdateComponent } from '../turn-update/turn-update.component';
import { GAME_INTENTS, SAVE_TRACE_INTENT } from '@app/core/constants/game-intents';
import { getLocale } from '@app/core/constants/locales';
import { I18nService, TranslatePipe } from '@app/core/i18n';
import { computed } from '@angular/core';
import { KATEX_DELIMITERS, hasKatexDelimiters } from '@app/core/utils/latex.util';

/** One rendered stat-change adornment under a model turn. */
interface StatChip {
    label: string;
    kind: 'gain' | 'loss' | 'neutral' | 'dropped' | 'event';
    tooltip: string;
}

@Component({
    selector: 'app-chat-message',
    standalone: true,
    imports: [
        ...CORE_MAT,
        ...PROGRESS_MAT,
        MatInputModule,
        MatFormFieldModule,
        FormsModule,
        NgTemplateOutlet,
        DecimalPipe,
        MarkdownModule,
        TextFieldModule,
        ContentSanitizerPipe,
        TurnUpdateComponent,
        TranslatePipe
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
    private statsView = inject(StatsViewService);

    protected readonly Intents = GAME_INTENTS;
    // Internal lock marker, not a user intent — never rendered as an intent chip.
    protected readonly SaveTraceIntent = SAVE_TRACE_INTENT;

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

    /**
     * Per-turn stat-change chips: the re-derived applied audit (post-clamp, with
     * drops) plus any triggered events for this model message. Empty unless the
     * Book runs the numeric-stats system and this turn changed a stat.
     */
    statChips = computed<StatChip[]>(() => {
        if (!this.gameState.hasStatsYaml()) return [];
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
            tooltip: d.reason ?? ''
        };
    }

    private signed(n: number): string {
        return n > 0 ? `+${n}` : `${n}`;
    }

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
