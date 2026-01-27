import { Component, inject, output, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSliderModule } from '@angular/material/slider';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatButtonModule } from '@angular/material/button';
import { GeminiService, DEFAULT_GEMINI_MODEL_ID } from '../../../core/services/gemini.service';
import { LLMModelDefinition } from '../../../core/services/llm-provider';

/**
 * Gemini-specific settings component.
 * Handles API Key, Model selection, Cache toggle, and generation parameters.
 */
@Component({
    selector: 'app-gemini-settings',
    standalone: true,
    imports: [CommonModule, FormsModule, MatFormFieldModule, MatInputModule, MatIconModule, MatSliderModule, MatSelectModule, MatSlideToggleModule, MatButtonModule],
    templateUrl: './gemini-settings.component.html',
    styleUrl: './gemini-settings.component.scss'
})
export class GeminiSettingsComponent {
    private gemini = inject(GeminiService);

    // Emits when settings change
    settingsChange = output<GeminiSettings>();

    // Form fields
    apiKey = signal('');
    modelId = signal(DEFAULT_GEMINI_MODEL_ID);
    hideKey = signal(true);
    enableCache = signal(false);
    thinkingLevelStory = signal('minimal');
    thinkingLevelGeneral = signal('high');

    // Model options from provider
    models = signal<LLMModelDefinition[]>([]);

    constructor() {
        this.models.set(this.gemini.getAvailableModels());
        this.loadSettings();

        // Auto-correct thinking levels when model changes
        effect(() => {
            const levels = this.availableThinkingLevels();

            // Story: Default to lowest option if current is invalid
            const story = this.thinkingLevelStory();
            if (!levels.includes(story)) {
                this.thinkingLevelStory.set(levels[0]);
            }

            // General: Default to highest option if current is invalid
            const general = this.thinkingLevelGeneral();
            if (!levels.includes(general)) {
                this.thinkingLevelGeneral.set(levels[levels.length - 1]);
            }
        });
    }

    private loadSettings(): void {
        this.apiKey.set(localStorage.getItem('gemini_api_key') || '');
        this.modelId.set(localStorage.getItem('gemini_model_id') || DEFAULT_GEMINI_MODEL_ID);
        this.enableCache.set(localStorage.getItem('gemini_enable_cache') === 'true');
        this.thinkingLevelStory.set(localStorage.getItem('gemini_thinking_level_story') || 'minimal');
        this.thinkingLevelGeneral.set(localStorage.getItem('gemini_thinking_level_general') || 'high');
    }

    currentModelDef = computed(() => this.models().find(m => m.id === this.modelId()));

    availableThinkingLevels = computed(() => {
        const m = this.currentModelDef();
        if (!m) return ['minimal', 'low', 'medium', 'high'];
        return m.allowedThinkingLevels || ['minimal', 'low', 'medium', 'high'];
    });

    getThinkingLevelLabel(level: string): string {
        switch (level) {
            case 'minimal': return 'Minimal';
            case 'low': return 'Low';
            case 'medium': return 'Medium';
            case 'high': return 'High';
            default: return level;
        }
    }

    getSettings(): GeminiSettings {

        return {
            apiKey: this.apiKey(),
            modelId: this.modelId(),
            enableCache: this.enableCache(),
            thinkingLevelStory: this.thinkingLevelStory(),
            thinkingLevelGeneral: this.thinkingLevelGeneral()
        };
    }

    isValid(): boolean {
        return !!this.apiKey().trim();
    }
}

export interface GeminiSettings {
    apiKey: string;
    modelId: string;
    enableCache: boolean;
    thinkingLevelStory: string;
    thinkingLevelGeneral: string;
}

