/**
 * Public types for the agent-runner loop infrastructure. Lives here (not in
 * `file-agent/file-agent.types.ts`) so the agent-runner module's dependency
 * direction stays one-way: file-agent → agent-runner. file-agent.types.ts
 * re-exports these for back-compat with existing imports across the codebase.
 *
 * Types that remain in file-agent.types.ts:
 * - `ParsedAction` — the file-agent-specific action discriminated union
 *   (each variant has a typed args interface). Save-sim's PerEntitySaveAgent
 *   will define its own action union in B 刀.
 * - `FileAgentContext` — the file-agent-specific runtime context. Save-sim
 *   defines its own. Generic-base-default `TContext` is loose intentionally.
 */

/**
 * Wide return type so sync tool executors stay unchanged; interactive tools
 * (e.g. proposeChatReplace) return a Promise. The dispatcher awaits this —
 * await on a non-thenable unwraps to the value directly.
 */
export type Awaitable<T> = T | PromiseLike<T>;

/** Result of executing a single tool call. */
export interface ToolExecutionResult {
    response: Record<string, unknown>;
    /** Optional info log to surface to the user (e.g. "Successfully updated X"). */
    infoLog?: string;
}

/**
 * One row in an agent's trace log. Same shape across file-agent's chat panel
 * (rendered into the AgentConsole UI) and save-sim's per-entity agents
 * (rendered into SaveProgressDialog cards), so subclasses can read each
 * other's traces.
 */
export interface AgentLogEntry {
    role: string;
    text: string;
    type: 'info' | 'error' | 'model' | 'action';
    thought?: string;
    isThoughtCollapsed?: boolean;
    isToolCall?: boolean;
    isToolCallCollapsed?: boolean;
    isToolResult?: boolean;
    isToolResultCollapsed?: boolean;
    toolName?: string;
    /** One-line caption shown next to a collapsed tool-call entry — surfaces the model's stated `reason` arg so the user (and the model on later turns) can see intent without expanding the entry. */
    reason?: string;
}
