import { Component, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSliderModule } from '@angular/material/slider';
import { LLMSettingsComponent } from '../../../core/services/llm-provider';

/**
 * OpenAI-specific settings component.
 * Handles API key, base URL, and model identifier configuration.
 */
@Component({
    selector: 'app-openai-settings',
    standalone: true,
    imports: [CommonModule, FormsModule, MatFormFieldModule, MatInputModule, MatIconModule, MatSliderModule],
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
    temperature = signal(0.7);
    inputPrice = signal(0);
    outputPrice = signal(0);

    constructor() {
        this.loadSettings();
    }

    private loadSettings(): void {
        this.baseUrl.set(localStorage.getItem('openai_base_url') || 'https://api.openai.com/v1');
        this.apiKey.set(localStorage.getItem('openai_api_key') || '');
        this.modelId.set(localStorage.getItem('openai_model_id') || 'gpt-4o');
        const savedTemp = localStorage.getItem('openai_temperature');
        if (savedTemp) {
            this.temperature.set(parseFloat(savedTemp));
        }
        this.inputPrice.set(parseFloat(localStorage.getItem('openai_input_price') || '0'));
        this.outputPrice.set(parseFloat(localStorage.getItem('openai_output_price') || '0'));
    }

    getSettings(): OpenAISettings {
        return {
            baseUrl: this.baseUrl(),
            apiKey: this.apiKey(),
            modelId: this.modelId(),
            temperature: this.temperature(),
            inputPrice: this.inputPrice(),
            outputPrice: this.outputPrice()
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
    temperature: number;
    inputPrice: number;
    outputPrice: number;
}
