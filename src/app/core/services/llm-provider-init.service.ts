import { Injectable, inject } from '@angular/core';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { GeminiService } from './gemini.service';
import { LlamaService } from './llama.service';
import { OpenAIService } from './openai.service';
import { DEFAULT_PROVIDER_ID } from './llm-provider';
import { GeminiSettingsComponent } from '../../features/settings/gemini-settings/gemini-settings.component';
import { LlamaSettingsComponent } from '../../features/settings/llama-settings/llama-settings.component';
import { OpenAISettingsComponent } from '../../features/settings/openai-settings/openai-settings.component';
import { LlamaV2Service } from './llama-v2.service';

@Injectable({
    providedIn: 'root'
})
export class LLMProviderInitService {
    private registry = inject(LLMProviderRegistryService);
    private gemini = inject(GeminiService);
    private llama = inject(LlamaService);
    private openai = inject(OpenAIService);
    private llamaV2 = inject(LlamaV2Service);
    initialize() {
        // Wire up UIs
        this.gemini.settingsComponent = GeminiSettingsComponent;
        this.llama.settingsComponent = LlamaSettingsComponent;
        this.openai.settingsComponent = OpenAISettingsComponent;

        this.registry.register(this.gemini);
        this.registry.register(this.llamaV2);
        this.registry.register(this.openai);

        // Load persisted provider choice
        const savedProvider = localStorage.getItem('llm_provider');
        if (savedProvider && this.registry.hasProvider(savedProvider)) {
            this.registry.setActive(savedProvider);
        } else {
            // Ensure a default provider is active immediately
            this.registry.setActive(DEFAULT_PROVIDER_ID);
        }

        console.log(`[LLMProviderInit] Providers registered. Active: ${this.registry.getActive()?.providerName}`);
    }
}
