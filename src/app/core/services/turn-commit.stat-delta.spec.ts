import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { TurnCommitService, TurnContext, CorrectionState } from './turn-commit.service';
import { CostService } from './cost.service';
import { GameStateService } from './game-state.service';
import { ChatHistoryService } from './chat-history.service';
import { SessionService } from './session.service';
import { LLMProviderRegistryService } from './llm-provider-registry.service';
import { StreamProcessResult } from './stream-processor.service';
import { ChatMessage } from '../models/types';
import { StatChange } from '../models/stats.types';
import { GAME_INTENTS } from '../constants/game-intents';

function makeResult(overrides: Partial<StreamProcessResult> = {}): StreamProcessResult {
    return {
        finalAnalysis: 'analysis',
        finalStory: 'story',
        finalSummary: 'summary',
        finalCharacterLog: [],
        finalInventoryLog: [],
        finalQuestLog: [],
        finalWorldLog: [],
        correction: '',
        turnUsage: { prompt: 0, candidates: 0, cached: 0 },
        capturedFCs: [],
        finalThought: '',
        ...overrides,
    };
}

/**
 * Drive `commitModelMessage` against in-memory stubs and return the model
 * message the commit produced — the only collaborator that mutates is
 * chatHistory.updateMessages, captured here.
 */
async function commitAndCapture(result: StreamProcessResult): Promise<ChatMessage> {
    const modelMsg: ChatMessage = { id: 'm1', role: 'model', content: '' };
    let messages: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'go' }, modelMsg];

    const chatHistoryStub = {
        updateMessages: async (updater: (prev: ChatMessage[]) => ChatMessage[]) => {
            messages = updater(messages);
        },
    };
    const stateStub = { messages: () => messages };

    const injector = Injector.create({
        providers: [
            { provide: CostService, useValue: {} },
            { provide: GameStateService, useValue: stateStub },
            { provide: ChatHistoryService, useValue: chatHistoryStub },
            { provide: SessionService, useValue: {} },
            { provide: LLMProviderRegistryService, useValue: {} },
        ],
    });
    const svc = runInInjectionContext(injector, () => new TurnCommitService());

    const turn: TurnContext = {
        userText: 'go',
        currentIntent: GAME_INTENTS.ACTION,
        forceFullContext: false,
        switchedFromLegacy: false,
        userMsgId: 'u1',
        modelMsgId: 'm1',
    };
    const noCorrection: CorrectionState = { isCorrection: false, correction: '' };

    await svc.commitModelMessage(turn, result, noCorrection);
    return messages[messages.length - 1];
}

describe('TurnCommitService stat_delta persistence', () => {
    it('round-trips stat_delta from the result onto the committed model message', async () => {
        const delta: StatChange[] = [
            { key: 'hp', delta: -5, reason: '受傷' },
            { key: 'affinity', subkey: '王如花', delta: 3 },
        ];
        const committed = await commitAndCapture(makeResult({ stat_delta: delta }));
        expect(committed.stat_delta).toEqual(delta);
    });

    it('defaults to [] when the engine produced no stat_delta (opt-in off)', async () => {
        const committed = await commitAndCapture(makeResult({ stat_delta: undefined }));
        expect(committed.stat_delta).toEqual([]);
    });
});
