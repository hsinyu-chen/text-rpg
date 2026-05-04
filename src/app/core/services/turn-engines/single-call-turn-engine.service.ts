import { Injectable, inject } from '@angular/core';
import { StreamProcessorService, StreamProcessResult } from '../stream-processor.service';
import { getResponseSchema } from '@app/core/constants/engine-protocol';
import { TurnEngine, TurnRunInput } from './turn-engine.interface';

@Injectable({ providedIn: 'root' })
export class SingleCallTurnEngine implements TurnEngine {
    private streamProcessor = inject(StreamProcessorService);

    async runTurn(input: TurnRunInput): Promise<StreamProcessResult> {
        const stream = input.provider.generateContentStream(
            input.providerConfig,
            input.history,
            input.systemInstruction,
            {
                cachedContentName: input.cachedContentName,
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
