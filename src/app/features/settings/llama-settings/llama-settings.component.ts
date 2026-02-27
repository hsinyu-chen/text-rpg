import { Component, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSliderModule } from '@angular/material/slider';
import { LLMSettingsComponent } from '../../../core/services/llm-provider';

/**
 * llama.cpp-specific settings component.
 * Handles server URL and model identifier configuration.
 */
@Component({
    selector: 'app-llama-settings',
    standalone: true,
    imports: [CommonModule, FormsModule, MatFormFieldModule, MatInputModule, MatIconModule, MatSliderModule],
    templateUrl: './llama-settings.component.html',
    styleUrl: './llama-settings.component.scss'
})
export class LlamaSettingsComponent implements LLMSettingsComponent {
    // Emits when settings change
    settingsChange = output<LlamaSettings>();

    // Form fields
    baseUrl = signal('http://localhost:8080');
    modelId = signal('local-model');
    temperature = signal<number | undefined>(undefined);
    inputPrice = signal<number | undefined>(undefined);
    outputPrice = signal<number | undefined>(undefined);

    constructor() {
        this.loadSettings();
    }

    private loadSettings(): void {
        this.baseUrl.set(localStorage.getItem('llama_base_url') || 'http://localhost:8080');
        this.modelId.set(localStorage.getItem('llama_model_id') || 'local-model');
        const savedTemp = localStorage.getItem('llama_temperature');
        this.temperature.set(savedTemp ? parseFloat(savedTemp) : undefined);
        const savedInPrice = localStorage.getItem('llama_input_price');
        this.inputPrice.set(savedInPrice ? parseFloat(savedInPrice) : undefined);
        const savedOutPrice = localStorage.getItem('llama_output_price');
        this.outputPrice.set(savedOutPrice ? parseFloat(savedOutPrice) : undefined);
    }

    getSettings(): LlamaSettings {
        return {
            baseUrl: this.baseUrl(),
            modelId: this.modelId(),
            temperature: this.temperature(),
            inputPrice: this.inputPrice(),
            outputPrice: this.outputPrice()
        };
    }

    isValid(): boolean {
        return !!this.baseUrl().trim();
    }
}

export interface LlamaSettings {
    baseUrl: string;
    modelId: string;
    temperature?: number;
    inputPrice?: number;
    outputPrice?: number;
}
