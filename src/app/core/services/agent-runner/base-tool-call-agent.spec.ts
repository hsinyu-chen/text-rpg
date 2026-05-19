import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { BaseToolCallAgent, TurnSetup, TurnContext } from './base-tool-call-agent';
import { Awaitable, BaseAction, ToolExecutionResult } from './agent-runner.types';
import type { LLMFunctionDeclaration } from '@hcs/llm-core';

/**
 * Focused spec for the `executeBatchActions(hasTerminalAfter)` contract that
 * `processAgentTurn` relies on when a parallel batch mixes non-terminal +
 * terminal actions (e.g. native+allowParallel model emitting
 * `[writeFile, submitResponse]`):
 *
 *   - `hasTerminalAfter=true` MUST skip the recursive next-turn call —
 *     `handleTerminalAction` is responsible for stopping the loop.
 *   - `hasTerminalAfter=true` MUST NOT consume the streaming log entry —
 *     `handleTerminalAction` writes the final message into it.
 *   - `hasTerminalAfter=false` keeps original behavior (recurses + may
 *     consume the streaming entry when there is no useful commentary).
 *
 * The full end-to-end loop is covered indirectly via file-agent runtime
 * usage; provider-stream mocking here would be much heavier than the slice
 * of behavior under test.
 */

interface TestContext { calls: BaseAction[] }

class TestAgent extends BaseToolCallAgent<BaseAction, TestContext> {
    recurseCount = 0;

    protected override get tools(): LLMFunctionDeclaration[] { return []; }
    protected override isTerminal(): boolean { return false; }
    protected override resolveTurnSetup(): TurnSetup | null { return null; }

    protected override async dispatchTool(action: BaseAction, ctx: TestContext): Promise<ToolExecutionResult> {
        ctx.calls.push(action);
        return { response: { ok: true } };
    }

    // Spy on processAgentTurn — invoked by executeBatchActions when recursing
    // for the next turn. We want to confirm it is NOT called when
    // hasTerminalAfter=true.
    protected override async processAgentTurn(): Promise<void> {
        this.recurseCount++;
    }

    // Expose protected internals.
    publicOpenTurn(): TurnContext { return this.openTurnLogEntry(); }
    publicExecuteBatch(actions: BaseAction[], ctx: TestContext, turnCtx: TurnContext, hasTerminal: boolean): Awaitable<void> {
        return this.executeBatchActions(actions, ctx, 'native', turnCtx, 0, hasTerminal);
    }
}

function setupAgent(): TestAgent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.runInInjectionContext(() => new TestAgent());
}

describe('BaseToolCallAgent.executeBatchActions — hasTerminalAfter sequencing', () => {
    it('hasTerminalAfter=true does NOT recurse (terminal handler is responsible for next step)', async () => {
        const agent = setupAgent();
        const turnCtx = agent.publicOpenTurn();
        const testCtx: TestContext = { calls: [] };

        await agent.publicExecuteBatch(
            [{ action: 'readFile', args: { filename: 'a.md' } }],
            testCtx, turnCtx, true,
        );

        expect(agent.recurseCount).toBe(0);
        expect(testCtx.calls.map(c => c.action)).toEqual(['readFile']);
    });

    it('hasTerminalAfter=true reserves the streaming log entry (does not overwrite it with a tool-call entry)', async () => {
        const agent = setupAgent();
        const turnCtx = agent.publicOpenTurn();
        const testCtx: TestContext = { calls: [] };

        const initialEntryRoleType = agent.agentLogs()[turnCtx.currentLogIndex].type;
        expect(initialEntryRoleType).toBe('model');

        await agent.publicExecuteBatch(
            [{ action: 'readFile', args: { filename: 'a.md' } }],
            testCtx, turnCtx, true,
        );

        // Streaming entry must still be the original 'model' entry — terminal
        // handler will overwrite it next with the user-facing final message.
        const reservedEntry = agent.agentLogs()[turnCtx.currentLogIndex];
        expect(reservedEntry.type).toBe('model');
        expect(reservedEntry.isToolCall).toBeFalsy();

        // Tool call entry exists as a separate appended entry.
        const toolCallEntries = agent.agentLogs().filter(e => e.isToolCall);
        expect(toolCallEntries.length).toBe(1);
    });

    it('hasTerminalAfter=false keeps original behavior — recurses for next turn', async () => {
        const agent = setupAgent();
        const turnCtx = agent.publicOpenTurn();
        const testCtx: TestContext = { calls: [] };

        await agent.publicExecuteBatch(
            [
                { action: 'readFile', args: { filename: 'a.md' } },
                { action: 'readFile', args: { filename: 'b.md' } },
            ],
            testCtx, turnCtx, false,
        );

        expect(agent.recurseCount).toBe(1);
        expect(testCtx.calls.length).toBe(2);
    });

    it('hasTerminalAfter=false consumes the streaming entry when there is no useful commentary', async () => {
        const agent = setupAgent();
        const turnCtx = agent.publicOpenTurn();
        const testCtx: TestContext = { calls: [] };

        // No accumulatedText → first tool call should land on the streaming entry.
        await agent.publicExecuteBatch(
            [{ action: 'readFile', args: { filename: 'a.md' } }],
            testCtx, turnCtx, false,
        );

        const reusedEntry = agent.agentLogs()[turnCtx.currentLogIndex];
        expect(reusedEntry.isToolCall).toBe(true);
    });

    it('hasTerminalAfter=true with multiple non-terminals appends a fresh log entry for each tool call', async () => {
        const agent = setupAgent();
        const turnCtx = agent.publicOpenTurn();
        const testCtx: TestContext = { calls: [] };

        await agent.publicExecuteBatch(
            [
                { action: 'readFile', args: { filename: 'a.md' } },
                { action: 'readFile', args: { filename: 'b.md' } },
            ],
            testCtx, turnCtx, true,
        );

        const toolCallEntries = agent.agentLogs().filter(e => e.isToolCall);
        expect(toolCallEntries.length).toBe(2);
        // The streaming entry is still untouched.
        expect(agent.agentLogs()[turnCtx.currentLogIndex].type).toBe('model');
        expect(agent.agentLogs()[turnCtx.currentLogIndex].isToolCall).toBeFalsy();
        // No recursion — terminal handler will run next.
        expect(agent.recurseCount).toBe(0);
    });
});

