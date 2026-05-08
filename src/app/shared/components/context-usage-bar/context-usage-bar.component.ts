import { Component, computed, inject, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { GameStateService } from '@app/core/services/game-state.service';
import { LLMProviderRegistryService } from '@app/core/services/llm-provider-registry.service';
import { ContextCompositionService } from '@app/core/services/context-composition.service';
import { AppConfigStore } from '@app/core/services/app-config-store';
import { TranslatePipe } from '@app/core/i18n';

/**
 * Renders a five-segment context-window usage bar (system / KB / chat history
 * compressed + recent / injection / output buffer). All numbers come from
 * {@link ContextCompositionService} — components don't drive the math.
 *
 * Variants via inputs:
 *   - `variant="full"`    sidebar mode: header ("Context | NN%"), counts
 *                          row, click-to-expand breakdown panel.
 *   - `variant="compact"` chip mode: just the bar with a chip-style outline.
 *                          Non-interactive (matches the row's other pills
 *                          stylistically without stealing focus / clicks).
 */
@Component({
    selector: 'app-context-usage-bar',
    standalone: true,
    imports: [CommonModule, MatIconModule, MatTooltipModule, TranslatePipe],
    templateUrl: './context-usage-bar.component.html',
    styleUrl: './context-usage-bar.component.scss',
    // Variant becomes a host class so the host element itself can `flex: 1`
    // in compact mode (it's the flex item — the inner `.compact` div can't
    // grow on its parent's behalf). Keeps consumers from having to apply a
    // magic class to opt into row-fill behaviour.
    host: {
        '[class.variant-compact]': "variant() === 'compact'",
        '[class.variant-full]': "variant() === 'full'"
    }
})
export class ContextUsageBarComponent {
    public state = inject(GameStateService);
    private providerRegistry = inject(LLMProviderRegistryService);
    public composition = inject(ContextCompositionService);
    public appConfig = inject(AppConfigStore);

    readonly variant = input<'full' | 'compact'>('full');

    breakdownExpanded = signal(false);
    toggleBreakdown() {
        if (this.variant() === 'compact') return;
        this.breakdownExpanded.update(v => !v);
    }

    private currentModelId = computed(() => this.providerRegistry.getActiveModelId() || 'Unknown');

    contextSize = computed<number | null>(() => {
        const modelId = this.currentModelId();
        const models = this.providerRegistry.getActiveModels();
        if (models.length === 0) return null;
        const match = models.find(m => m.id === modelId)
            ?? (models.length === 1 ? models[0] : null);
        return match?.contextSize ?? null;
    });

    contextUsed = computed<number>(() => this.composition.totalTokens());

    contextUsagePercent = computed<number>(() => {
        const size = this.contextSize();
        const used = this.contextUsed();
        if (!size || size <= 0) return 0;
        return Math.min(100, (used / size) * 100);
    });

    private segmentPercent(tokens: number): number {
        const size = this.contextSize();
        if (!size || size <= 0) return 0;
        return (tokens / size) * 100;
    }

    systemPct = computed(() => this.segmentPercent(this.composition.systemPromptTokens()));
    kbPct = computed(() => this.segmentPercent(this.state.estimatedKbTokens()));
    historyCompressedPct = computed(() => this.segmentPercent(this.composition.historyCompressedTokens()));
    historyRecentPct = computed(() => this.segmentPercent(this.composition.historyRecentTokens()));
    injectionPct = computed(() => this.segmentPercent(this.composition.effectiveInjectionTokens()));
    bufferPct = computed(() => this.segmentPercent(this.composition.bufferTokens()));

    contextUsageLevel = computed<'safe' | 'warning' | 'high' | 'critical'>(() => {
        const pct = this.contextUsagePercent();
        if (pct >= 95) return 'critical';
        if (pct >= 80) return 'high';
        if (pct >= 60) return 'warning';
        return 'safe';
    });

    // Tooltip used by the compact variant — must surface the same actionable
    // info ("am I about to overflow?") that the full variant reveals via
    // its header + breakdown.
    compactTooltip = computed(() => {
        const size = this.contextSize();
        if (!size) {
            // Pre-model-load (or unrecognized model id) — surfacing the
            // raw `used` number without a denominator just adds noise
            // (a 50K KB looks alarming until you realize there's no limit
            // resolved). Keep the chip discoverable but say what's wrong.
            return 'Context limit unknown — model not yet resolved';
        }
        const used = this.contextUsed();
        const pct = this.contextUsagePercent();
        return `Context: ${used.toLocaleString()} / ${size.toLocaleString()} tk (${pct.toFixed(1)}%)`;
    });

    // Engine-mode aware tooltip for the injection breakdown row.
    injectionBreakdownTooltip = computed(() =>
        this.appConfig.engineMode() === 'two-call'
            ? 'max(resolver, narrator) — 2-call worst case'
            : 'protocol_single + action injection'
    );
}
