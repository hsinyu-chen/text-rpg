import { Injectable, inject } from '@angular/core';
import { LLMProvider } from '@hcs/llm-core';
import { ContextBuilderService } from '../context-builder.service';
import { GameStateService } from '../game-state.service';
import { LLMProviderRegistryService } from '../llm-provider-registry.service';
import { StreamProcessorService, StreamProcessResult } from '../stream-processor.service';
import { getResponseSchema } from '../../constants/engine-protocol';
import { TurnEngine, TurnRunInput } from './turn-engine.interface';

@Injectable({ providedIn: 'root' })
export class SingleCallTurnEngine implements TurnEngine {
    private providerRegistry = inject(LLMProviderRegistryService);
    private state = inject(GameStateService);
    private contextBuilder = inject(ContextBuilderService);
    private streamProcessor = inject(StreamProcessorService);

    private get provider(): LLMProvider {
        const p = this.providerRegistry.getActive();
        if (!p) throw new Error('No active LLM provider');
        return p;
    }

    async runTurn(input: TurnRunInput): Promise<StreamProcessResult> {
        const omitKB = this.contextBuilder.shouldOmitKbFromSystemInstruction();

        const stream = this.provider.generateContentStream(
            this.providerRegistry.getActiveConfig(),
            input.history,
            this.contextBuilder.getEffectiveSystemInstruction(!omitKB),
            {
                cachedContentName: this.state.kbCacheName() || undefined,
                responseSchema: getResponseSchema(input.outputLanguage),
                responseMimeType: 'application/json',
                intent: input.intent,
                signal: input.signal
            }
        );

        return this.streamProcessor.processStream(
            stream,
            input.modelMsgId,
            input.outputLanguage,
            input.updateMessages
        );
    }
}
