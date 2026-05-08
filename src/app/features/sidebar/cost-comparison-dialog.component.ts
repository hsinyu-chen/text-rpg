import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { GameEngineService } from '@app/core/services/game-engine.service';
import { GameStateService } from '@app/core/services/game-state.service';
import { LLMProviderRegistryService } from '@app/core/services/llm-provider-registry.service';
import { CostService } from '@app/core/services/cost.service';
import { LLMModelDefinition } from '@hcs/llm-core';
import { TranslatePipe } from '@app/core/i18n';

interface ModelCostInfo {
    model: LLMModelDefinition;
    isActive: boolean;
    turnCost: number;
    totalCost: number;
}

@Component({
    selector: 'app-cost-comparison-dialog',
    standalone: true,
    imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule, TranslatePipe],
    templateUrl: './cost-comparison-dialog.component.html',
    styleUrl: './cost-comparison-dialog.component.scss'
})
export class CostComparisonDialogComponent {
    private engine = inject(GameEngineService);
    private state = inject(GameStateService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private costService = inject(CostService);
    private dialogRef = inject(MatDialogRef<CostComparisonDialogComponent>);

    modelCosts = computed<ModelCostInfo[]>(() => {
        const lastTurn = this.state.lastTurnUsage();
        const exchangeRate = this.costService.displayRate();

        // Active Model for Storage Scaling
        const activeModelId = this.providerRegistry.getActiveModelId() || 'gemini-3-flash-preview';

        // Base Storage Costs
        const storageUsage = this.state.storageUsageAccumulated();
        const historyStorageUsage = this.state.historyStorageUsageAccumulated();

        // Calculate Cost dynamically for the ACTIVE model (since this is "Session Total")
        this.costService.calculateStorageCost(storageUsage + historyStorageUsage, activeModelId);

        const models = this.providerRegistry.getActiveModels();
        const messages = this.state.messages();

        return models.map(model => {
            const isActive = model.id === activeModelId;

            // Calculate turn cost for this model
            let turnCost = 0;
            if (lastTurn) {
                const totalInput = lastTurn.freshInput + lastTurn.cached;
                const rates = model.getRates(totalInput);
                const fresh = lastTurn.freshInput;
                turnCost = (fresh / 1_000_000 * rates.input) +
                    (lastTurn.output / 1_000_000 * rates.output) +
                    (lastTurn.cached / 1_000_000 * (rates.cached || 0));
            }

            // 1. Transaction Cost: 100% Accurate Replay
            const transactionCost = this.costService.calculateSessionTransactionCost(messages, model);

            // 1.b Sunk Transaction Cost: Preserving tiered pricing
            let sunkTransactionCost = 0;
            const sunkHistory = this.state.sunkUsageHistory();
            for (const usage of sunkHistory) {
                const rates = model.getRates(usage.prompt);
                const fresh = usage.prompt - usage.cached;
                sunkTransactionCost += (fresh / 1_000_000 * rates.input) +
                    (usage.candidates / 1_000_000 * rates.output) +
                    (usage.cached / 1_000_000 * (rates.cached || 0));
            }

            // 2. Storage Cost: Calculated Dynamically
            // Use the accumulated usage (Token-Seconds) to calculate cost for THIS model's rate
            const totalUsage = storageUsage + historyStorageUsage;
            const modelStorageCost = this.costService.calculateStorageCost(totalUsage, model.id);

            const totalCost = transactionCost + sunkTransactionCost + modelStorageCost;

            return {
                model,
                isActive,
                turnCost: turnCost * exchangeRate,
                totalCost: totalCost * exchangeRate
            };
        });
    });

    formatCost(cost: number): string {
        const currency = this.costService.displayCurrency();
        const decimals = currency === 'USD' ? 4 : 2;
        return `${currency} $${cost.toFixed(decimals)}`;
    }
}
