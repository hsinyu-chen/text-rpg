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

        const storage = this.state.storageCostAccumulated() + this.state.historyStorageCostAccumulated();
        return activeTxn + sunkTxn + storage;
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
        const activeModel = activeProvider.getAvailableModels().find(m => m.id === activeModelId);

        // Derive Active Token Usage from message history (Robust computed signal)
        const activeUsage = this.activeUsage();

        // Identfy Last Turn Data (Robust computed signal)
        const messages = this.state.messages();
        const lastTurn = this.computedLastTurnUsage();

        // Base Storage Costs (Accumulated on active sessions)
        const storageCostAcc = this.state.storageCostAccumulated();
        const historyStorageCostAcc = this.state.historyStorageCostAccumulated();
        const baseTotalStorageCost = storageCostAcc + historyStorageCostAcc;

        const models = activeProvider.getAvailableModels();
        const turns = this.turnCount();
        const sunkHistory = this.state.sunkUsageHistory();

        const sunkTurns = sunkHistory.length;
        const sunkFresh = sunkHistory.reduce((acc, u) => acc + (u.prompt - u.cached), 0);
        const sunkCached = sunkHistory.reduce((acc, u) => acc + u.cached, 0);
        const sunkOutput = sunkHistory.reduce((acc, u) => acc + u.candidates, 0);

        let markdown = `## SESSION TOTAL\n\n`;
        if (lastTurn) {
            markdown += `| Metric | Last Turn | Active | Sunk | Total |\n|--------|-----------|-------|------|-------|\n`;
            markdown += `| New Input | ${(lastTurn.prompt - lastTurn.cached).toLocaleString()} | ${activeUsage.freshInput.toLocaleString()} | ${sunkFresh.toLocaleString()} | ${(activeUsage.freshInput + sunkFresh).toLocaleString()} |\n`;
            markdown += `| Cached | ${lastTurn.cached.toLocaleString()} | ${activeUsage.cached.toLocaleString()} | ${sunkCached.toLocaleString()} | ${(activeUsage.cached + sunkCached).toLocaleString()} |\n`;
            markdown += `| Output | ${lastTurn.candidates.toLocaleString()} | ${activeUsage.output.toLocaleString()} | ${sunkOutput.toLocaleString()} | ${(activeUsage.output + sunkOutput).toLocaleString()} |\n`;
            markdown += `| Total Sent | ${(lastTurn.prompt + lastTurn.candidates).toLocaleString()} | ${activeUsage.total.toLocaleString()} | ${(sunkFresh + sunkCached + sunkOutput).toLocaleString()} | ${(activeUsage.total + sunkFresh + sunkCached + sunkOutput).toLocaleString()} |\n\n`;
        } else {
            markdown += `| Metric | Active | Sunk | Total |\n|--------|-------|------|-------|\n`;
            markdown += `| Turns | ${turns} | ${sunkTurns} | ${turns + sunkTurns} |\n`;
            markdown += `| New Input | ${activeUsage.freshInput.toLocaleString()} | ${sunkFresh.toLocaleString()} | ${(activeUsage.freshInput + sunkFresh).toLocaleString()} |\n`;
            markdown += `| Cached | ${activeUsage.cached.toLocaleString()} | ${sunkCached.toLocaleString()} | ${(activeUsage.cached + sunkCached).toLocaleString()} |\n`;
            markdown += `| Output | ${activeUsage.output.toLocaleString()} | ${sunkOutput.toLocaleString()} | ${(activeUsage.output + sunkOutput).toLocaleString()} |\n`;
            markdown += `| Total Sent | ${activeUsage.total.toLocaleString()} | ${(sunkFresh + sunkCached + sunkOutput).toLocaleString()} | ${(activeUsage.total + sunkFresh + sunkCached + sunkOutput).toLocaleString()} |\n\n`;
        }

        markdown += `## Model Cost Comparison\n\n`;
        markdown += `| Model | Session Cost (${currency}) | Status |\n|-------|-------------------|--------|\n`;

        models.forEach(model => {
            const isActive = model.id === activeModelId;

            // 1. Transaction Cost: 100% Accurate Replay
            const transactionCost = this.costService.calculateSessionTransactionCost(messages, model);

            // 1.b Sunk Transaction Cost
            let sunkTransactionCost = 0;
            for (const u of sunkHistory) {
                sunkTransactionCost += this.costService.calculateTurnCost({
                    prompt: u.prompt,
                    cached: u.cached,
                    candidates: u.candidates
                }, model.id);
            }

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
