import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';

import { GameEngineService } from '../../../../core/services/game-engine.service';
import { LLMProviderRegistryService } from '../../../../core/services/llm-provider-registry.service';
import { CostService } from '../../../../core/services/cost.service';
import { CostComparisonDialogComponent } from '../../cost-comparison-dialog.component';

@Component({
    selector: 'app-sidebar-cost-prediction',
    standalone: true,
    imports: [CommonModule, MatButtonModule, MatIconModule, MatTooltipModule],
    templateUrl: './sidebar-cost-prediction.component.html',
    styleUrl: './sidebar-cost-prediction.component.scss'
})
export class SidebarCostPredictionComponent {
    engine = inject(GameEngineService);
    matDialog = inject(MatDialog);
    snackBar = inject(MatSnackBar);
    providerRegistry = inject(LLMProviderRegistryService);
    costService = inject(CostService);

    // Count model responses as turns
    turnCount = computed(() => {
        return this.engine.messages().filter(m => m.role === 'model' && !m.isRefOnly).length;
    });

    // Real-time Total Cost (Transactions + Storage) for Active Model
    // Re-calculated from history to ensure consistency with Copy/Dialog and handle Rewinds correctly
    totalSessionCost = computed(() => {
        const activeProvider = this.providerRegistry.getActive();
        const activeModelId = this.engine.config()?.modelId || activeProvider?.getDefaultModelId();
        const model = activeProvider?.getAvailableModels().find(m => m.id === activeModelId);

        if (!model) return 0;

        const txn = this.costService.calculateSessionTransactionCost(this.engine.messages(), model);
        const storage = this.engine.storageCostAccumulated() + this.engine.historyStorageCostAccumulated();
        return txn + storage;
    });

    displayCurrency = computed(() => {
        const cfg = this.engine.config();
        return (cfg?.enableConversion && cfg?.currency) ? cfg.currency : 'USD';
    });

    displayRate = computed(() => {
        const cfg = this.engine.config();
        if (cfg?.enableConversion && cfg?.currency !== 'USD') {
            return cfg.exchangeRate || 30;
        }
        return 1;
    });

    openCostComparison() {
        this.matDialog.open(CostComparisonDialogComponent, {
            width: '450px',
            maxHeight: '80vh'
        });
    }

    copySessionStats() {
        const usage = this.engine.tokenUsage();
        const config = this.engine.config();

        const currency = this.displayCurrency();
        const exchangeRate = this.displayRate();

        const activeProvider = this.providerRegistry.getActive();
        if (!activeProvider) return;

        const activeModelId = config?.modelId || activeProvider.getDefaultModelId();
        const activeModel = activeProvider.getAvailableModels().find(m => m.id === activeModelId);

        // Base Storage Costs (Accumulated on active sessions)
        const storageCostAcc = this.engine.storageCostAccumulated();
        const historyStorageCostAcc = this.engine.historyStorageCostAccumulated();
        const baseTotalStorageCost = storageCostAcc + historyStorageCostAcc;

        const models = activeProvider.getAvailableModels();
        const turns = this.turnCount();
        const messages = this.engine.messages();

        let markdown = `## SESSION TOTAL\n\n`;
        markdown += `| Metric | Value |\n|--------|-------|\n`;
        markdown += `| Turns | ${turns} |\n`;
        markdown += `| New Input | ${usage.freshInput.toLocaleString()} |\n`;
        markdown += `| Cached | ${usage.cached.toLocaleString()} |\n`;
        markdown += `| Output | ${usage.output.toLocaleString()} |\n`;
        markdown += `| Total Sent | ${usage.total.toLocaleString()} |\n\n`;

        markdown += `## Model Cost Comparison\n\n`;
        markdown += `| Model | Session Cost (${currency}) | Status |\n|-------|-------------------|--------|\n`;

        models.forEach(model => {
            const isActive = model.id === activeModelId;

            // 1. Transaction Cost: 100% Accurate Replay
            // Re-calculate cost for EVERY turn using this model's specific rates at that size
            const transactionCost = this.costService.calculateSessionTransactionCost(messages, model);

            // 2. Storage Cost: Estimated scaling
            // Scale storage cost based on the ratio of storage rates (if active model is known)
            let modelStorageCost = 0;
            if (activeModel) {
                // Get approximate storage rates (using 0 tokens to get base rate, as typical storage rate is constant per 1M)
                const activeStorageRate = activeModel.getRates(0).cacheStorage || 0;
                const modelStorageRate = model.getRates(0).cacheStorage || 0;

                if (activeStorageRate > 0) {
                    modelStorageCost = baseTotalStorageCost * (modelStorageRate / activeStorageRate);
                } else if (isActive) {
                    modelStorageCost = baseTotalStorageCost;
                }
            } else if (isActive) {
                modelStorageCost = baseTotalStorageCost;
            }

            const totalCost = transactionCost + modelStorageCost;

            const costFormatted = (totalCost * exchangeRate).toFixed(currency === 'USD' ? 4 : 2);
            const status = isActive ? '✅ Active' : '';
            markdown += `| ${model.name} | ${currency} ${costFormatted} | ${status} |\n`;
        });

        navigator.clipboard.writeText(markdown).then(() => {
            this.snackBar.open('Stats copied to clipboard!', 'OK', { duration: 2000 });
        });
    }
}
