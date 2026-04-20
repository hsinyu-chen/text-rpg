import { Component, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSliderModule } from '@angular/material/slider';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSelectModule } from '@angular/material/select';
import { LLMSettingsComponent, LLMProviderConfig } from '../../../core/services/llm-provider';

/**
 * llama.cpp-specific settings component.
 * Handles server URL and model identifier configuration.
 */
@Component({
    selector: 'app-llama-settings',
    standalone: true,
    imports: [
        CommonModule,
        FormsModule,
        MatFormFieldModule,
        MatInputModule,
        MatIconModule,
        MatSliderModule,
        MatSlideToggleModule,
        MatSelectModule
    ],
    templateUrl: './llama-settings.component.html',
    styleUrl: './llama-settings.component.scss'
})
export class LlamaSettingsComponent implements LLMSettingsComponent {
    // Emits when settings change
    settingsChange = output<LlamaSettings>();

    // Form fields
    baseUrl = signal('http://localhost:8080');
    modelId = signal('local-model');
    isFetching = signal(false);
    temperature = signal<number | undefined>(undefined);
    inputPrice = signal<number | undefined>(undefined);
    outputPrice = signal<number | undefined>(undefined);
    cachedPrice = signal<number | undefined>(undefined);
    topP = signal<number | undefined>(undefined);
    topK = signal<number | undefined>(undefined);
    minP = signal<number | undefined>(undefined);
    repetitionPenalty = signal<number | undefined>(undefined);
    enableThinking = signal<boolean>(false);
    reasoningEffort = signal<string>('low');
    enableSaveSlot = signal<boolean>(false);

    constructor() {
        this.loadSettings();
    }

    async onBaseUrlChange(value: string): Promise<void> {
        this.baseUrl.set(value);
        localStorage.setItem('llama_base_url', value);
        await this.fetchModel();
    }

    async fetchModel(): Promise<void> {
        const url = this.baseUrl();
        if (!url) return;

        this.isFetching.set(true);
        try {
            const cleanUrl = url.replace(/\/$/, '');
            const response = await fetch(`${cleanUrl}/props`);
            if (response.ok) {
                const data = await response.json();
                if (data.model_alias) {
                    this.modelId.set(data.model_alias);
                    this.settingsChange.emit(this.getSettings() as LlamaSettings);
                } else if (data.model_path) {
                    // Fallback to basename of model_path
                    const modelId = data.model_path.split(/[/\\]/).pop() || data.model_path;
                    this.modelId.set(modelId);
                    this.settingsChange.emit(this.getSettings() as LlamaSettings);
                }
            }
        } catch (e) {
            console.warn('[LlamaSettings] Fetch failed', e);
        } finally {
            this.isFetching.set(false);
        }
    }

    private async loadSettings(): Promise<void> {
        this.baseUrl.set(localStorage.getItem('llama_base_url') || 'http://localhost:8080');
        this.modelId.set(localStorage.getItem('llama_model_id') || 'local-model');
        await this.fetchModel();
        const savedTemp = localStorage.getItem('llama_temperature');
        this.temperature.set(savedTemp ? parseFloat(savedTemp) : undefined);
        const savedInPrice = localStorage.getItem('llama_input_price');
        this.inputPrice.set(savedInPrice ? parseFloat(savedInPrice) : undefined);
        const savedOutPrice = localStorage.getItem('llama_output_price');
        this.outputPrice.set(savedOutPrice ? parseFloat(savedOutPrice) : undefined);
        const savedCachedPrice = localStorage.getItem('llama_cached_price');
        this.cachedPrice.set(savedCachedPrice ? parseFloat(savedCachedPrice) : undefined);

        const savedTopP = localStorage.getItem('llama_top_p');
        this.topP.set(savedTopP ? parseFloat(savedTopP) : undefined);
        const savedTopK = localStorage.getItem('llama_top_k');
        this.topK.set(savedTopK ? parseFloat(savedTopK) : undefined);
        const savedMinP = localStorage.getItem('llama_min_p');
        this.minP.set(savedMinP ? parseFloat(savedMinP) : undefined);
        const savedRepPenalty = localStorage.getItem('llama_repetition_penalty');
        this.repetitionPenalty.set(savedRepPenalty ? parseFloat(savedRepPenalty) : undefined);
        const savedThinking = localStorage.getItem('llama_enable_thinking');
        this.enableThinking.set(savedThinking === 'true');
        const savedEffort = localStorage.getItem('llama_reasoning_effort');
        this.reasoningEffort.set(savedEffort || 'low');
        this.enableSaveSlot.set(localStorage.getItem('llama_enable_save_slot') === 'true');
    }

    getSettings(): LLMProviderConfig {
        return {
            baseUrl: this.baseUrl(),
            modelId: this.modelId(),
            temperature: this.temperature(),
            inputPrice: this.inputPrice(),
            outputPrice: this.outputPrice(),
            cachedPrice: this.cachedPrice(),
            topP: this.topP(),
            topK: this.topK(),
            minP: this.minP(),
            repetitionPenalty: this.repetitionPenalty(),
            enableThinking: this.enableThinking(),
            reasoningEffort: this.reasoningEffort(),
            enableCache: this.enableSaveSlot(),
            additionalSettings: {
                topP: this.topP(),
                topK: this.topK(),
                minP: this.minP(),
                repetitionPenalty: this.repetitionPenalty(),
                enableThinking: this.enableThinking(),
                reasoningEffort: this.reasoningEffort()
            }
        };
    }

    isValid(): boolean {
        return !!this.baseUrl().trim();
    }
}

export interface LlamaSettings extends LLMProviderConfig {
    baseUrl: string;
    modelId: string;
}
