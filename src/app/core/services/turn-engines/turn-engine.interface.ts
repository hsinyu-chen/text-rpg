import { LLMContent } from '@hcs/llm-core';
import { ChatMessage } from '../../models/types';
import { StreamProcessResult } from '../stream-processor.service';

export interface TurnRunInput {
    history: LLMContent[];
    intent: string;
    outputLanguage: string;
    modelMsgId: string;
    signal: AbortSignal;
    updateMessages: (updater: (prev: ChatMessage[]) => ChatMessage[]) => void;
}

export interface TurnEngine {
    runTurn(input: TurnRunInput): Promise<StreamProcessResult>;
}
