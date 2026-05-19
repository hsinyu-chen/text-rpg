import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ReadOnlyAgent } from './read-only-agent';
import { TurnSetup } from './base-tool-call-agent';
import type { FileAgentContext, ParsedAction, ToolExecutionResult } from '../file-agent/file-agent.types';

/**
 * Spec target: ReadOnlyAgent's public contract — read tool dispatch routes
 * to KB / chat read executors; dispatchReadTool returns null on non-read
 * actions so subclasses (FileAgentService, future PerEntitySaveAgent) can
 * compose their own dispatch.
 *
 * BaseToolCallAgent's loop is covered end-to-end via file-agent.service.spec
 * — repeating that here would duplicate ~100 assertions. This spec only
 * verifies the ReadOnly layer in isolation.
 */

class TestReadOnlyAgent extends ReadOnlyAgent<ParsedAction> {
    protected override isTerminal(): boolean { return false; }
    protected override resolveTurnSetup(): TurnSetup | null { return null; }

    /** Public proxy for the protected dispatchReadTool — tests need it. */
    publicDispatchReadTool(action: ParsedAction, context: FileAgentContext): ToolExecutionResult | null {
        return this.dispatchReadTool(action, context);
    }

    /** Public proxy for the protected dispatchTool. */
    publicDispatchTool(action: ParsedAction, context: FileAgentContext): Promise<ToolExecutionResult> | ToolExecutionResult {
        return this.dispatchTool(action, context);
    }

    /** Expose tools getter for assertion. */
    publicTools() { return this.tools; }
}

function setupAgent(): TestReadOnlyAgent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.runInInjectionContext(() => new TestReadOnlyAgent());
}

function ctxWithFiles(entries: Record<string, string>): FileAgentContext {
    return {
        files: new Map(Object.entries(entries)),
        onFileReplaced: () => { /* noop — read-only agent never writes */ },
    };
}

describe('ReadOnlyAgent — tool catalog', () => {
    it('exposes KB read + chat read tools (8 total today)', () => {
        const agent = setupAgent();
        const tools = agent.publicTools();
        const names = tools.map(t => t.name).sort();
        expect(names).toEqual([
            'getFileOutline', 'grep', 'listChatMessages', 'readChatMessage',
            'readFile', 'readSection', 'readTurnLogs', 'searchChatMessages',
        ]);
    });
});

describe('ReadOnlyAgent — dispatchReadTool', () => {
    it('returns null for actions outside the read catalog', () => {
        const agent = setupAgent();
        const result = agent.publicDispatchReadTool(
            { action: 'replaceFile', args: { filename: 'a.md', content: 'x' } } as ParsedAction,
            ctxWithFiles({}),
        );
        expect(result).toBeNull();
    });

    it('returns a tool result for kb-read actions (readFile)', () => {
        const agent = setupAgent();
        const result = agent.publicDispatchReadTool(
            { action: 'readFile', args: { filename: 'x.md' } } as ParsedAction,
            ctxWithFiles({ 'x.md': 'hello\nworld' }),
        );
        expect(result).not.toBeNull();
        expect(result!.response).toMatchObject({ content: 'hello\nworld', totalLines: 2 });
    });

    it('returns a tool result for chat-read actions (listChatMessages with chat snapshot)', () => {
        const agent = setupAgent();
        const ctx: FileAgentContext = {
            ...ctxWithFiles({}),
            chatMessages: [
                { id: 'm1', role: 'user', content: 'hi', summary: '', isHidden: false } as never,
            ],
        };
        const result = agent.publicDispatchReadTool(
            { action: 'listChatMessages', args: {} } as ParsedAction,
            ctx,
        );
        expect(result).not.toBeNull();
        const resp = result!.response as { messages?: unknown[] };
        expect(Array.isArray(resp.messages)).toBe(true);
    });
});

describe('ReadOnlyAgent — dispatchTool fallback error', () => {
    it('returns "unknown read-only action" for non-read actions when subclass does not override', () => {
        const agent = setupAgent();
        const result = agent.publicDispatchTool(
            { action: 'replaceFile', args: { filename: 'a.md', content: 'x' } } as ParsedAction,
            ctxWithFiles({}),
        ) as ToolExecutionResult;
        expect(result.response).toMatchObject({ error: expect.stringContaining('Unknown read-only action') });
    });
});

describe('ReadOnlyAgent — inherited loop state from BaseToolCallAgent', () => {
    it('exposes agentHistory / agentLogs / isAgentRunning / token + progress signals', () => {
        const agent = setupAgent();
        expect(typeof agent.agentHistory).toBe('function');
        expect(typeof agent.agentLogs).toBe('function');
        expect(typeof agent.isAgentRunning).toBe('function');
        expect(typeof agent.generatedTokenCount).toBe('function');
        expect(typeof agent.generatedChunkCount).toBe('function');
        expect(typeof agent.promptProgress).toBe('function');
        // initial state
        expect(agent.agentHistory()).toEqual([]);
        expect(agent.agentLogs()).toEqual([]);
        expect(agent.isAgentRunning()).toBe(false);
    });

    it('stopAgent clears running flag + progress', () => {
        const agent = setupAgent();
        agent.isAgentRunning.set(true);
        agent.promptProgress.set(0.42);
        agent.stopAgent();
        expect(agent.isAgentRunning()).toBe(false);
        expect(agent.promptProgress()).toBeUndefined();
    });

    it('clearHistory wipes history + logs when not running', () => {
        const agent = setupAgent();
        agent.agentHistory.set([{ role: 'user', parts: [{ text: 'x' }] }]);
        agent.agentLogs.set([{ role: 'user', text: 'x', type: 'info' }]);
        agent.clearHistory();
        expect(agent.agentHistory()).toEqual([]);
        expect(agent.agentLogs()).toEqual([]);
    });

    it('clearHistory refuses while a turn is in flight', () => {
        const agent = setupAgent();
        agent.agentHistory.set([{ role: 'user', parts: [{ text: 'in-flight' }] }]);
        agent.isAgentRunning.set(true);
        agent.clearHistory();
        // History was NOT cleared because running flag was set.
        expect(agent.agentHistory()).toHaveLength(1);
    });
});

