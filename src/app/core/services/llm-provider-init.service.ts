import { Injectable, inject } from '@angular/core';
import { LLMProviderRegistry } from '@hcs/llm-core';
import { GeminiProvider } from '@hcs/llm-provider-gemini';
import { LlamaCppProvider } from '@hcs/llm-provider-llama-cpp';
import { OpenAIProvider } from '@hcs/llm-provider-openai';
import { GeminiConfigComponent } from '@hcs/llm-angular-ui-gemini';
import { LlamaConfigComponent } from '@hcs/llm-angular-ui-llama-cpp';
import { OpenAIConfigComponent } from '@hcs/llm-angular-ui-openai';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { LLMConfigService } from './llm-config.service';

@Injectable({ providedIn: 'root' })
export class LLMProviderInitService {
    private registry = inject(LLMProviderRegistryService);
    private monorepoRegistry = inject(LLMProviderRegistry);
    private configService = inject(LLMConfigService);

    async initialize() {
        // Register each stateless provider instance in BOTH registries:
        //   - TextRPG's LLMProviderRegistryService powers the app's call sites
        //   - The monorepo's LLMProviderRegistry is what LLMSettingsComponent /
        //     LLMManager consult when resolving provider/UI pairs for the
        //     profile editor.
        const gemini = new GeminiProvider();
        const llama = new LlamaCppProvider();
        const openai = new OpenAIProvider();

        for (const p of [gemini, llama, openai]) {
            this.registry.register(p);
            this.monorepoRegistry.register(p);
        }

        // Register provider-UI components under the `settingsComponentId` each
        // monorepo provider advertises; LLMSettingsComponent reads these to
        // mount the right form inside its edit panel.
        if (gemini.settingsComponentId) this.monorepoRegistry.registerUIComponent(gemini.settingsComponentId, GeminiConfigComponent);
        if (llama.settingsComponentId) this.monorepoRegistry.registerUIComponent(llama.settingsComponentId, LlamaConfigComponent);
        if (openai.settingsComponentId) this.monorepoRegistry.registerUIComponent(openai.settingsComponentId, OpenAIConfigComponent);

        // Wait for the profile list to hydrate (including legacy migration) so
        // downstream services that read the active profile during their own
        // init don't get an empty state.
        await this.configService.waitReady();

        console.log(`[LLMProviderInit] Providers registered. Active profile:`,
            this.configService.activeProfile()?.name ?? '(none)');
    }
}
