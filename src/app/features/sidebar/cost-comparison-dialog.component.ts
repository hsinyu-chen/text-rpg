import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { GameEngineService } from '../../core/services/game-engine.service';
import { GameStateService } from '../../core/services/game-state.service';
import { LLMProviderRegistryService } from '../../core/services/llm-provider-registry.service';
import { CostService } from '../../core/services/cost.service';
import { LLMModelDefinition } from '../../core/services/llm-provider';

interface ModelCostInfo {
    model: LLMModelDefinition;
    isActive: boolean;
    turnCost: number;
    totalCost: number;
}

@Component({
    selector: 'app-cost-comparison-dialog',
    standalone: true,
    imports: [CommonModule, MatDialogModule, MatButtonModule, MatIconModule],
    template: `
        <h2 mat-dialog-title>
            <mat-icon>compare_arrows</mat-icon>
            Model Cost Comparison
        </h2>
        <mat-dialog-content>
            <div class="model-list">
                @for (info of modelCosts(); track info.model.id) {
                    <div class="model-item" [class.inactive]="!info.isActive" [class.active]="info.isActive">
                        <div class="model-header">
                            <span class="model-name">{{ info.model.name }}</span>
                            @if (info.isActive) {
                                <span class="badge">Active</span>
                            }
                        </div>
                        <div class="cost-row">
                            <span class="label">Last Turn Cost</span>
                            <span class="value">{{ formatCost(info.turnCost) }}</span>
                        </div>
                        <div class="cost-row total">
                            <span class="label">Session Total Cost</span>
                            <span class="value">{{ formatCost(info.totalCost) }}</span>
                        </div>
                    </div>
                }
            </div>
            <p class="hint">* Inactive models show hypothetical costs as if they were used for the entire session history.</p>
        </mat-dialog-content>
        <mat-dialog-actions align="end">
            <button mat-button mat-dialog-close>Close</button>
        </mat-dialog-actions>
    `,
    styles: [`
        :host {
            display: block;
        }

        h2[mat-dialog-title] {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 0;
            padding: 16px 24px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        mat-dialog-content {
            padding: 16px 24px;
            max-height: 60vh;
        }

        .model-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .model-item {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 12px 16px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: all 0.2s ease;

            &.active {
                border-color: var(--mat-primary-color, #7c4dff);
                background: rgba(124, 77, 255, 0.1);
            }

            &.inactive {
                opacity: 0.6;
            }
        }

        .model-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 8px;
        }

        .model-name {
            font-weight: 500;
            font-size: 1rem;
        }

        .badge {
            background: var(--mat-primary-color, #7c4dff);
            color: white;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 500;
        }

        .cost-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0;
            font-size: 0.875rem;
            color: rgba(255, 255, 255, 0.7);

            &.total {
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                margin-top: 4px;
                padding-top: 8px;
                font-weight: 500;
                color: rgba(255, 255, 255, 0.9);
            }
        }

        .label {
            color: inherit;
        }

        .value {
            font-family: 'Roboto Mono', monospace;
        }

        .hint {
            margin-top: 16px;
            font-size: 0.75rem;
            color: rgba(255, 255, 255, 0.5);
            font-style: italic;
        }

        mat-dialog-actions {
            padding: 8px 16px 16px;
        }
    `]
})
export class CostComparisonDialogComponent {
    private engine = inject(GameEngineService);
    private state = inject(GameStateService);
    private providerRegistry = inject(LLMProviderRegistryService);
    private costService = inject(CostService);
    private dialogRef = inject(MatDialogRef<CostComparisonDialogComponent>);

    modelCosts = computed<ModelCostInfo[]>(() => {
        const lastTurn = this.state.lastTurnUsage();
        const config = this.state.config();

        const enabled = config?.enableConversion ?? false;
        // If conversion disabled -> USD. If enabled -> selected currency.
        const currency = (enabled && config?.currency) ? config.currency : 'USD';
        // If conversion enabled AND not USD -> use rate. Else 1.
        const exchangeRate = (enabled && currency !== 'USD') ? (config?.exchangeRate || 30) : 1;

        // Active Model for Storage Scaling
        const activeModelId = this.state.config()?.modelId || 'gemini-3-flash-preview';
        const activeProvider = this.providerRegistry.getActive();

        // Base Storage Costs
        const storageUsage = this.state.storageUsageAccumulated();
        const historyStorageUsage = this.state.historyStorageUsageAccumulated();

        // Calculate Cost dynamically for the ACTIVE model (since this is "Session Total")
        this.costService.calculateStorageCost(storageUsage + historyStorageUsage, activeModelId);

        const models = activeProvider ? activeProvider.getAvailableModels() : [];
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
        const config = this.state.config();
        const enabled = config?.enableConversion ?? false;
        const currency = (enabled && config?.currency) ? config.currency : 'USD';
        const decimals = currency === 'USD' ? 4 : 2;
        return `${currency} $${cost.toFixed(decimals)}`;
    }
}
