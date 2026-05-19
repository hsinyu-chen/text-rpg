import { LLMFunctionDeclaration } from '@hcs/llm-core';
import { Awaitable, ParsedAction, ToolExecutionResult } from '../file-agent/file-agent.types';
import { BaseToolCallAgent } from './base-tool-call-agent';
import { KB_READ_TOOLS } from './tools/kb-read-tools';
import { CHAT_READ_TOOLS } from './tools/chat-read-tools';
import { dispatchKbReadTool, KbReadContext } from './tools/kb-read-tools-executor';
import { dispatchChatReadTool, ChatReadContext } from './tools/chat-read-tools-executor';

/** Minimum context shape a `ReadOnlyAgent` subclass must provide — file
 *  snapshot for kb-read tools + optional chat snapshot for chat-read tools. */
export type ReadOnlyAgentContext = KbReadContext & ChatReadContext;

/**
 * Read-only tool catalog layer on top of {@link BaseToolCallAgent}. Exposes
 * `KB_READ_TOOLS` (readFile / grep / getFileOutline / readSection) and
 * `CHAT_READ_TOOLS` (listChatMessages / searchChatMessages / readChatMessage
 * / readTurnLogs) and dispatches them through the shared per-domain
 * executors.
 *
 * Two known subclasses today:
 * - {@link import('../file-agent/file-agent.service').FileAgentService}
 *   adds write tools, UI-help tools, propose-chat-replace, flow-control,
 *   and chat-panel UI integration.
 * - (planned) save-sim's `PerEntitySaveAgent` adds `proposeDiff` /
 *   `commitNoChange` commit tools for fog-of-war-gated per-entity diffs.
 *
 * Subclasses still need to implement:
 * - `isTerminal` — when does the loop end (submitResponse / proposeDiff / etc.)
 * - `resolveTurnSetup` — LLM profile + provider + system instruction
 *
 * Subclasses MAY override `get tools` / `dispatchTool` to ADD more tools
 * by spreading `super.tools` and falling through to `super.dispatchTool`.
 */
/** The canonical read-only catalog — cached at module load so the getter
 *  doesn't reallocate per turn. Subclasses that ADD tools spread into a
 *  fresh array via `super.tools` (which returns this constant by reference). */
const READ_ONLY_TOOLS: readonly LLMFunctionDeclaration[] = [...KB_READ_TOOLS, ...CHAT_READ_TOOLS];

export abstract class ReadOnlyAgent<TAction extends ParsedAction = ParsedAction, TContext extends ReadOnlyAgentContext = ReadOnlyAgentContext>
    extends BaseToolCallAgent<TAction, TContext> {

    protected get tools(): LLMFunctionDeclaration[] {
        return READ_ONLY_TOOLS as LLMFunctionDeclaration[];
    }

    protected dispatchTool(action: TAction, context: TContext): Awaitable<ToolExecutionResult> {
        const result = this.dispatchReadTool(action, context);
        if (result !== null) return result;
        return { response: { error: `Unknown read-only action: ${action.action}` } };
    }

    /**
     * Read-only tool dispatch sub-step that returns `null` when the action
     * is not in the read catalog — subclasses that ADD their own tools
     * (write / commit / etc.) call this from their own `dispatchTool`
     * override, then fall through to their own handlers on null.
     */
    protected dispatchReadTool(action: TAction, context: TContext): ToolExecutionResult | null {
        const kbRead = dispatchKbReadTool(action, context);
        if (kbRead !== null) return kbRead;

        const chatRead = dispatchChatReadTool(action, context);
        if (chatRead !== null) return chatRead;

        return null;
    }
}
