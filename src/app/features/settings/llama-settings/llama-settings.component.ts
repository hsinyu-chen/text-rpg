import { Component, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';

/**
 * llama.cpp-specific settings component.
 * Handles server URL and model identifier configuration.
 */
@Component({
    selector: 'app-llama-settings',
    standalone: true,
    imports: [CommonModule, FormsModule, MatFormFieldModule, MatInputModule, MatIconModule],
    templateUrl: './llama-settings.component.html',
    styleUrl: './llama-settings.component.scss'
})
export class LlamaSettingsComponent {
    // Emits when settings change
    settingsChange = output<LlamaSettings>();

    // Form fields
    baseUrl = signal('http://localhost:8080');
    modelId = signal('local-model');

    constructor() {
        this.loadSettings();
    }

    private loadSettings(): void {
        this.baseUrl.set(localStorage.getItem('llama_base_url') || 'http://localhost:8080');
        this.modelId.set(localStorage.getItem('llama_model_id') || 'local-model');
    }

    getSettings(): LlamaSettings {
        return {
            baseUrl: this.baseUrl(),
            modelId: this.modelId()
        };
    }

    isValid(): boolean {
        return !!this.baseUrl().trim();
    }
}

export interface LlamaSettings {
    baseUrl: string;
    modelId: string;
}
