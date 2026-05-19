/**
 * Public types for the agent-runner loop infrastructure. Lives here (not in
 * `file-agent/file-agent.types.ts`) so the agent-runner module has zero
 * imports back into file-agent — one-way dependency direction:
 * file-agent → agent-runner. file-agent.types.ts re-exports the args + base
 * action types for back-compat with existing imports across the codebase.
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

/**
 * Shape every action that flows through `BaseToolCallAgent.processAgentTurn`
 * must conform to: a discriminator name + args payload + optional native
 * function-call id for round-trip with provider tool-call APIs.
 *
 * `args: unknown` keeps the base loop type-safe without constraining
 * subclasses to a specific args shape. Each subclass narrows TAction to its
 * own discriminated union with typed args (e.g. file-agent's `ParsedAction`,
 * save-sim's planned `SaveSimAction`).
 */
export interface BaseAction {
    action: string;
    args: unknown;
    callId?: string;
}

/**
 * Common arg present on every file-operation tool (and most read tools).
 * Used as `reason` for the agent's user-visible action trace caption.
 */
export interface BaseToolArgs {
    reason?: string;
}

// ============================================================================
// Read-only tool args — declared here because the corresponding tool
// declarations (KB_READ_TOOLS / CHAT_READ_TOOLS) and their executor
// dispatchers (dispatchKbReadTool / dispatchChatReadTool) all live in
// agent-runner/tools/. file-agent.types.ts re-exports them for back-compat.
// ============================================================================

export interface ReadFileArgs extends BaseToolArgs {
    filename: string;
    startLine?: number;
    lineCount?: number;
}

export interface GrepArgs extends BaseToolArgs {
    pattern: string;
    filename?: string;
    caseInsensitive?: boolean;
    maxResults?: number;
    contextLines?: number;
}

export interface GetFileOutlineArgs extends BaseToolArgs {
    filename: string;
}

export interface ReadSectionArgs extends BaseToolArgs {
    filename: string;
    sectionPaths: string[];
}

export type ChatSearchScope = 'content' | 'thought' | 'summary' | 'all';
export type ChatReadField = 'content' | 'thought' | 'logs' | 'analysis' | 'summary' | 'intent';
export type TurnLogKind = 'character' | 'world' | 'inventory' | 'quest';

export interface ListChatMessagesArgs extends BaseToolArgs {
    limit?: number;
    before?: string;
    includeHidden?: boolean;
    /** Default false. Save turns (intent === 'save') are engine-administrative file-update turns full of XML tags — usually noise for narrative questions. Set true only when the user is asking about KB-write history itself. */
    includeSaves?: boolean;
}

export interface SearchChatMessagesArgs extends BaseToolArgs {
    pattern: string;
    scope?: ChatSearchScope;
    caseInsensitive?: boolean;
    limit?: number;
    contextChars?: number;
    /** Default false. See ListChatMessagesArgs.includeSaves. */
    includeSaves?: boolean;
}

export interface ReadChatMessageArgs extends BaseToolArgs {
    messageIds: string[];
    include?: ChatReadField[];
}

export interface ReadTurnLogsArgs extends BaseToolArgs {
    messageIds?: string[];
    kinds?: TurnLogKind[];
    recent?: number;
}

/**
 * Discriminated union of every read-only action the `ReadOnlyAgent` base
 * exposes — KB-read (readFile / grep / getFileOutline / readSection) +
 * chat-read (listChatMessages / searchChatMessages / readChatMessage /
 * readTurnLogs). Concrete subclasses widen TAction by `union`ing this with
 * their own write/commit/etc. action union (see file-agent's
 * `ParsedAction = ReadOnlyAction | WriteOnlyAction`).
 */
export type ReadOnlyAction =
    | { action: 'readFile'; args: ReadFileArgs; callId?: string }
    | { action: 'grep'; args: GrepArgs; callId?: string }
    | { action: 'getFileOutline'; args: GetFileOutlineArgs; callId?: string }
    | { action: 'readSection'; args: ReadSectionArgs; callId?: string }
    | { action: 'listChatMessages'; args: ListChatMessagesArgs; callId?: string }
    | { action: 'searchChatMessages'; args: SearchChatMessagesArgs; callId?: string }
    | { action: 'readChatMessage'; args: ReadChatMessageArgs; callId?: string }
    | { action: 'readTurnLogs'; args: ReadTurnLogsArgs; callId?: string };
