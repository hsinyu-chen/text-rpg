import { Injectable, inject } from '@angular/core';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { GeminiService } from './gemini.service';
import { LlamaService } from './llama.service';
import { DEFAULT_PROVIDER_ID } from './llm-provider';

@Injectable({
    providedIn: 'root'
})
export class LLMProviderInitService {
    private registry = inject(LLMProviderRegistryService);
    private gemini = inject(GeminiService);
    private llama = inject(LlamaService);

    initialize() {
        this.registry.register(this.gemini);
        this.registry.register(this.llama);

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
