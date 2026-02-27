import { Component, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSliderModule } from '@angular/material/slider';
import { MatSelectModule } from '@angular/material/select';
import { LLMSettingsComponent } from '../../../core/services/llm-provider';
import { computed } from '@angular/core';

/**
 * OpenAI-specific settings component.
 * Handles API key, base URL, and model identifier configuration.
 */
@Component({
    selector: 'app-openai-settings',
    standalone: true,
    imports: [CommonModule, FormsModule, MatFormFieldModule, MatInputModule, MatIconModule, MatSliderModule, MatSelectModule],
    templateUrl: './openai-settings.component.html',
    styleUrl: './openai-settings.component.scss'
})
export class OpenAISettingsComponent implements LLMSettingsComponent {
    // Emits when settings change
    settingsChange = output<OpenAISettings>();

    // Form fields
    baseUrl = signal('https://api.openai.com/v1');
    apiKey = signal('');
    modelId = signal('gpt-4o');
    temperature = signal<number | undefined>(undefined);
    inputPrice = signal<number | undefined>(undefined);
    outputPrice = signal<number | undefined>(undefined);
    cachedPrice = signal<number | undefined>(undefined);

    // Presets
    presets: OpenAIPricetPreset[] = [
        { modelId: 'gpt-5.2', input: 1.75, cached: 0.175, output: 14.00 },
        { modelId: 'gpt-5.1', input: 1.25, cached: 0.125, output: 10.00 },
        { modelId: 'gpt-5', input: 1.25, cached: 0.125, output: 10.00 },
        { modelId: 'gpt-5-mini', input: 0.25, cached: 0.025, output: 2.00 },
        { modelId: 'gpt-5-nano', input: 0.05, cached: 0.005, output: 0.40 },
        { modelId: 'gpt-5.2-chat-latest', input: 1.75, cached: 0.175, output: 14.00 },
        { modelId: 'gpt-5.1-chat-latest', input: 1.25, cached: 0.125, output: 10.00 },
        { modelId: 'gpt-5-chat-latest', input: 1.25, cached: 0.125, output: 10.00 },
        { modelId: 'gpt-5.3-codex', input: 1.75, cached: 0.175, output: 14.00 },
        { modelId: 'gpt-5.2-codex', input: 1.75, cached: 0.175, output: 14.00 },
        { modelId: 'gpt-5.1-codex-max', input: 1.25, cached: 0.125, output: 10.00 },
        { modelId: 'gpt-5.1-codex', input: 1.25, cached: 0.125, output: 10.00 },
        { modelId: 'gpt-5-codex', input: 1.25, cached: 0.125, output: 10.00 },
        { modelId: 'gpt-5.2-pro', input: 21.00, cached: undefined, output: 168.00 },
        { modelId: 'gpt-5-pro', input: 15.00, cached: undefined, output: 120.00 },
        { modelId: 'gpt-4.1', input: 2.00, cached: 0.50, output: 8.00 },
        { modelId: 'gpt-4.1-mini', input: 0.40, cached: 0.10, output: 1.60 },
        { modelId: 'gpt-4.1-nano', input: 0.10, cached: 0.025, output: 0.40 },
        { modelId: 'gpt-4o', input: 2.50, cached: 1.25, output: 10.00 },
        { modelId: 'gpt-4o-mini', input: 0.15, cached: 0.075, output: 0.60 },
        { modelId: 'gpt-4o-audio-preview', input: 2.50, cached: undefined, output: 10.00 },
        { modelId: 'gpt-4o-mini-audio-preview', input: 0.15, cached: undefined, output: 0.60 },
        { modelId: 'o1', input: 15.00, cached: 7.50, output: 60.00 },
        { modelId: 'o1-pro', input: 150.00, cached: undefined, output: 600.00 },
        { modelId: 'o3-pro', input: 20.00, cached: undefined, output: 80.00 },
        { modelId: 'o3', input: 2.00, cached: 0.50, output: 8.00 },
        { modelId: 'o3-deep-research', input: 10.00, cached: 2.50, output: 40.00 },
        { modelId: 'o4-mini', input: 1.10, cached: 0.275, output: 4.40 },
        { modelId: 'o4-mini-deep-research', input: 2.00, cached: 0.50, output: 8.00 },
        { modelId: 'o3-mini', input: 1.10, cached: 0.55, output: 4.40 },
        { modelId: 'o1-mini', input: 1.10, cached: 0.55, output: 4.40 },
    ];

    showPresets = computed(() => this.baseUrl().trim() === 'https://api.openai.com/v1');

    applyPreset(preset: OpenAIPricetPreset): void {
        this.modelId.set(preset.modelId);
        this.inputPrice.set(preset.input);
        this.outputPrice.set(preset.output);
        this.cachedPrice.set(preset.cached);
    }

    constructor() {
        this.loadSettings();
    }

    private loadSettings(): void {
        this.baseUrl.set(localStorage.getItem('openai_base_url') || 'https://api.openai.com/v1');
        this.apiKey.set(localStorage.getItem('openai_api_key') || '');
        this.modelId.set(localStorage.getItem('openai_model_id') || 'gpt-4o');
        const savedTemp = localStorage.getItem('openai_temperature');
        this.temperature.set(savedTemp ? parseFloat(savedTemp) : undefined);
        const savedInPrice = localStorage.getItem('openai_input_price');
        this.inputPrice.set(savedInPrice ? parseFloat(savedInPrice) : undefined);
        const savedOutPrice = localStorage.getItem('openai_output_price');
        this.outputPrice.set(savedOutPrice ? parseFloat(savedOutPrice) : undefined);
        const savedCachedPrice = localStorage.getItem('openai_cached_price');
        this.cachedPrice.set(savedCachedPrice ? parseFloat(savedCachedPrice) : undefined);
    }

    getSettings(): OpenAISettings {
        return {
            baseUrl: this.baseUrl(),
            apiKey: this.apiKey(),
            modelId: this.modelId(),
            temperature: this.temperature(),
            inputPrice: this.inputPrice(),
            outputPrice: this.outputPrice(),
            cachedPrice: this.cachedPrice()
        };
    }

    isValid(): boolean {
        // API Key is usually required unless it's a local proxy without auth
        return !!this.baseUrl().trim() && !!this.modelId().trim();
    }
}

export interface OpenAISettings {
    baseUrl: string;
    apiKey: string;
    modelId: string;
    temperature?: number;
    inputPrice?: number;
    outputPrice?: number;
    cachedPrice?: number;
}

export interface OpenAIPricetPreset {
    modelId: string;
    input: number;
    cached: number | undefined;
    output: number;
}
