import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';

import { GameEngineService } from '../../../../core/services/game-engine.service';
import { GameStateService } from '../../../../core/services/game-state.service';
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
    public engine = inject(GameEngineService);
    public state = inject(GameStateService);
    public matDialog = inject(MatDialog);
    public snackBar = inject(MatSnackBar);
    public providerRegistry = inject(LLMProviderRegistryService);
    public costService = inject(CostService);

    // Count model responses as turns
    turnCount = computed(() => {
        return this.state.messages().filter(m => m.role === 'model' && !m.isRefOnly).length;
    });

    // Derive Active Token Usage from message history (More robust than signal, which might be cleared)
    activeUsage = computed(() => {
        const messages = this.state.messages();
        return messages.reduce((acc, msg) => {
            if (msg.role === 'model' && msg.usage && !msg.isRefOnly) {
                acc.freshInput += (msg.usage.prompt - msg.usage.cached);
                acc.cached += msg.usage.cached;
                acc.output += msg.usage.candidates;
                acc.total += (msg.usage.prompt + msg.usage.candidates);
            }
            return acc;
        }, { freshInput: 0, cached: 0, output: 0, total: 0 });
    });

    // robust Last Turn Data (Prefer signal, fallback to last valid history item)
    computedLastTurnUsage = computed(() => {
        const signalVal = this.state.lastTurnUsage();
        if (signalVal) {
            return {
                prompt: signalVal.freshInput + signalVal.cached,
                cached: signalVal.cached,
                candidates: signalVal.output
            };
        }

        const messages = this.state.messages();
        const lastModelMsg = [...messages].reverse().find(m => m.role === 'model' && m.usage && !m.isRefOnly);
        if (lastModelMsg && lastModelMsg.usage) {
            return {
                prompt: lastModelMsg.usage.prompt,
                cached: lastModelMsg.usage.cached,
                candidates: lastModelMsg.usage.candidates
            };
        }
        return null;
    });

    lastTurnCost = computed(() => {
        const turn = this.computedLastTurnUsage();
        if (!turn) return 0;
        return this.costService.calculateTurnCost(turn, this.state.config()?.modelId);
    });

    // Real-time Total Cost (Transactions + Storage) for Active Model
    // Re-calculated from history to ensure consistency with Copy/Dialog and handle Rewinds correctly
    totalSessionCost = computed(() => {
        const activeProvider = this.providerRegistry.getActive();
        const activeModelId = this.state.config()?.modelId || activeProvider?.getDefaultModelId();
        const model = activeProvider?.getAvailableModels().find(m => m.id === activeModelId);

        if (!model) return 0;

        const messages = this.state.messages();
        const sunkHistory = this.state.sunkUsageHistory();

        const activeTxn = this.costService.calculateSessionTransactionCost(messages, model);

        let sunkTxn = 0;
        for (const usage of sunkHistory) {
            sunkTxn += this.costService.calculateTurnCost({
                prompt: usage.prompt,
                cached: usage.cached,
                candidates: usage.candidates
            }, model.id);
        }

        const activeUsage = this.state.storageUsageAccumulated();
        const historyUsage = this.state.historyStorageUsageAccumulated();

        const storageCost = this.costService.calculateStorageCost(activeUsage + historyUsage, model.id);

        return activeTxn + sunkTxn + storageCost;
    });

    // Helper computed for Template Display
    activeStorageCostDisplay = computed(() => {
        const usage = this.state.storageUsageAccumulated();
        return this.costService.calculateStorageCost(usage, this.state.config()?.modelId);
    });

    historyStorageCostDisplay = computed(() => {
        const usage = this.state.historyStorageUsageAccumulated();
        return this.costService.calculateStorageCost(usage, this.state.config()?.modelId);
    });

    displayCurrency = computed(() => {
        const cfg = this.state.config();
        return (cfg?.enableConversion && cfg?.currency) ? cfg.currency : 'USD';
    });

    displayRate = computed(() => {
        const cfg = this.state.config();
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
        const config = this.state.config();

        const currency = this.displayCurrency();
        const exchangeRate = this.displayRate();

        const activeProvider = this.providerRegistry.getActive();
        if (!activeProvider) return;

        const activeModelId = config?.modelId || activeProvider.getDefaultModelId();
        // activeModel variable removed as it was unused

        // Derive Active Token Usage from message history (Robust computed signal)
        const activeUsage = this.activeUsage();

        // Identfy Last Turn Data (Robust computed signal)
        const lastTurn = this.computedLastTurnUsage();

        // Costs for active session and last turn
        const lastTurnCostVal = this.lastTurnCost();
        const totalSessionCostVal = this.totalSessionCost();

        // Base Storage Usage (Accumulated on active sessions)
        const storageUsageAcc = this.state.storageUsageAccumulated();
        const historyStorageUsageAcc = this.state.historyStorageUsageAccumulated();

        // Calculate storage COST for current model
        const currentModelId = config?.modelId || activeModelId;
        const currentModelStorageCost = this.costService.calculateStorageCost(storageUsageAcc, currentModelId);
        const historyModelStorageCost = this.costService.calculateStorageCost(historyStorageUsageAcc, currentModelId);

        const models = activeProvider.getAvailableModels();
        const turns = this.turnCount();
        const sunkHistory = this.state.sunkUsageHistory();

        let markdown = `## SESSION TOTAL\n\n`;
        const formatMoney = (val: number) => {
            const formatted = (val * exchangeRate).toFixed(currency === 'USD' ? 4 : 2);
            return `${currency} ${formatted}`;
        };

        if (lastTurn) {
            markdown += `| Metric | Last Turn | Session Total |\n|--------|-----------|---------------|\n`;
            markdown += `| Turns | 1 | ${turns} |\n`;
            markdown += `| New Input | ${(lastTurn.prompt - lastTurn.cached).toLocaleString()} | ${activeUsage.freshInput.toLocaleString()} |\n`;
            markdown += `| Cached | ${lastTurn.cached.toLocaleString()} | ${activeUsage.cached.toLocaleString()} |\n`;
            markdown += `| Output | ${lastTurn.candidates.toLocaleString()} | ${activeUsage.output.toLocaleString()} |\n`;
            markdown += `| Total Sent | ${(lastTurn.prompt + lastTurn.candidates).toLocaleString()} | ${activeUsage.total.toLocaleString()} |\n`;
            markdown += `| Est. Cost | ${formatMoney(lastTurnCostVal)} | ${formatMoney(totalSessionCostVal)} |\n\n`;
        } else {
            markdown += `| Metric | Session Total |\n|--------|---------------|\n`;
            markdown += `| Turns | ${turns} |\n`;
            markdown += `| New Input | ${activeUsage.freshInput.toLocaleString()} |\n`;
            markdown += `| Cached | ${activeUsage.cached.toLocaleString()} |\n`;
            markdown += `| Output | ${activeUsage.output.toLocaleString()} |\n`;
            markdown += `| Total Sent | ${activeUsage.total.toLocaleString()} |\n`;
            markdown += `| Est. Cost | ${formatMoney(totalSessionCostVal)} |\n\n`;
        }

        // Add Storage Cost Breakdown (Match UI rows)
        if (storageUsageAcc > 0 || historyStorageUsageAcc > 0) {
            markdown += `### Storage Costs (Est.)\n`;
            if (storageUsageAcc > 0) {
                markdown += `- Storage Cost: ${formatMoney(currentModelStorageCost)} (Active)\n`;
            }
            if (historyStorageUsageAcc > 0) {
                markdown += `- Hist. Cache Cost: ${formatMoney(historyModelStorageCost)}\n`;
            }
            markdown += `\n`;
        }

        markdown += `## Model Cost Comparison\n\n`;
        markdown += `| Model | Session Cost (${currency}) | Status |\n|-------|-------------------|--------|\n`;

        models.forEach(model => {
            const isActive = model.id === activeModelId;

            // 1. Transaction Cost: 100% Accurate Replay
            const transactionCost = this.costService.calculateSessionTransactionCost(this.state.messages(), model);

            // 1.b Sunk Transaction Cost (Included in total just like UI's "Total Est. Cost")
            let sunkTransactionCost = 0;
            for (const u of sunkHistory) {
                sunkTransactionCost += this.costService.calculateTurnCost({
                    prompt: u.prompt,
                    cached: u.cached,
                    candidates: u.candidates
                }, model.id);
            }

            // 2. Storage Cost: Calculated Dynamically from Token-Seconds
            const totalUsage = storageUsageAcc + historyStorageUsageAcc;
            const modelStorageCost = this.costService.calculateStorageCost(totalUsage, model.id);

            const totalCost = transactionCost + sunkTransactionCost + modelStorageCost;

            const costFormatted = (totalCost * exchangeRate).toFixed(currency === 'USD' ? 4 : 2);
            const status = isActive ? '✅ Active' : '';
            markdown += `| ${model.name} | ${currency} ${costFormatted} | ${status} |\n`;
        });

        navigator.clipboard.writeText(markdown).then(() => {
            this.snackBar.open('Stats copied to clipboard!', 'OK', { duration: 2000 });
        });
    }
}
