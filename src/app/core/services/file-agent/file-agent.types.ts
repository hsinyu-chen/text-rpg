import type { ChatMessage } from '@app/core/models/types';
import type { GameIntent } from '@app/core/constants/game-intents';

/** Where in a chat message to search / replace. */
export type ChatReplaceField = 'all' | 'story' | 'summary' | 'logs';

/** A proposed chat-wide find/replace, identical in shape to the values the
 *  user could fill into the chat-replace dialog by hand. */
export interface ChatReplaceProposal {
  search: string;
  replace: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  intentFilter?: 'all' | GameIntent;
  roleFilter?: 'all' | 'user' | 'model';
  fieldFilter?: ChatReplaceField;
}

/** Outcome surfaced by the chat-replace dialog after the user resolves an
 *  agent-proposed run. `cancelled` covers both the explicit Cancel button
 *  and closing the dialog without applying. */
export interface ChatReplaceOutcome {
  applied: {
    search: string;
    replace: string;
    filters: {
      intent: 'all' | GameIntent;
      role: 'all' | 'user' | 'model';
      field: ChatReplaceField;
    };
    replaceCount: number;
  } | null;
  cancelled: boolean;
  /** True when the user changed any prefilled field before applying. Lets
   *  the agent acknowledge a divergence in its next-turn narration. */
  divergedFromProposal: boolean;
}

/** Wide return type so existing synchronous tool handlers stay unchanged;
 *  interactive tools (e.g. proposeChatReplace) return a Promise. The
 *  executor's caller awaits this — await on a non-thenable unwraps to
 *  the value directly. */
export type Awaitable<T> = T | PromiseLike<T>;

export interface FileAgentContext {
  files: Map<string, string>;
  onFileReplaced: (filename: string, content: string) => void;
  /**
   * In-game chat snapshot for the chat-aware tools (listChatMessages,
   * searchChatMessages, readChatMessage, readTurnLogs). Snapshot, not signal —
   * the agent turn is short and the executor is synchronous. Omit (or pass
   * an empty array) when no game is active, e.g. createWorldMode: chat-aware
   * tools degrade to a "no chat history available" error.
   */
  chatMessages?: ChatMessage[];
  /** Resolved UI locale id (e.g. "zh-TW", "en") — the language the agent should respond IN. Surfaced in the system prompt so the agent doesn't have to guess from the user message. */
  uiLanguage?: string;
  /** Engine output-language setting (e.g. "zh-TW", "en", "default") — the language the in-game narrative is being written in. Surfaced so chat-aware searches don't waste turns on the wrong language. */
  narrativeLanguage?: string;
  /**
   * Read-only mode: write tools (replaceFile, searchReplace, replaceSection,
   * insertSection, insertIntoSection) are rejected at dispatch with an error
   * directing the user to the KB editor. Used on the main-screen agent surface
   * where there is no editor view — silently mutating files would mean edits
   * happen invisibly and the user can't review them before they hit the engine.
   */
  readOnly?: boolean;
  /**
   * Which physical AgentConsole instance is invoking the executor. Two mount
   * points exist: the chat-panel console (`main`, also used for the PiP
   * popout) and the file-viewer dialog's embedded console (`file-edit`).
   * Surfaced on the user-message tag so the LLM perceives which console
   * the user is interacting through, and used to gate interactive tools
   * (e.g. proposeChatReplace) that only make sense on `main`. Defaults to
   * `main` when omitted.
   */
  surface?: 'main' | 'file-edit';
  /**
   * Interactive proposers — closures that pop user-facing approval UI and
   * resolve to a structured outcome. Kept off the executor module proper
   * so the executor stays Angular-free; the AgentConsole builds each
   * closure (matDialog.open(...).afterClosed() wrapped as a Promise) and
   * injects them per run. Omit for surfaces / call-sites that don't host
   * propose-tools — the handler then rejects the call with a clear error.
   */
  proposers?: {
    chatReplace?: (params: ChatReplaceProposal) => Promise<ChatReplaceOutcome>;
  };
  /**
   * Optional. When provided, the `uiMap` tool delegates here for the full
   * UI tree dump. FileAgentService injects this from `AgentHintRegistry`;
   * the callback keeps the executor DI-free.
   */
  uiMap?: () => string;
  /**
   * Snapshot of all books in the user's library (slim form). FileAgentService
   * populates this from BookRepository at turn start; the executor's listBooks
   * tool reads from here so it stays DI-free and sync. Omit (or empty) when
   * no library access — listBooks then degrades to a "no books available" error.
   */
  books?: BookSummary[];
  /**
   * Snapshot of all collections (folders) in the library. Paired with `books`
   * for the listCollections tool. Same injection contract.
   */
  collections?: CollectionSummary[];
  /**
   * Id of the currently-loaded book, or null when no book is loaded
   * (world-creation mode, freshly cleared session). Surfaced on listBooks
   * results so the agent can flag the active row.
   */
  activeBookId?: string | null;
}

/**
 * Public input shape for `FileAgentService.runAgent`. Looser than the
 * executor-internal `FileAgentContext` — `onFileReplaced` is optional (the
 * service supplies a default that routes writes through
 * `AgentPanelStateService.editChannel` and throws `EditChannelLostError` when
 * the channel is null, e.g. file-viewer closed mid-turn). UI surfaces omit it;
 * bridge / tests pass their own to keep writes isolated from live state.
 *
 * `proposers` is similarly optional — the service wires a `MatDialog`-backed
 * chatReplace proposer when omitted; bridge / tests can omit to fall back to
 * the executor's "not wired" tool-error response.
 */
export interface FileAgentRunInput extends Omit<FileAgentContext, 'onFileReplaced'> {
  onFileReplaced?: (filename: string, content: string) => void;
}

/**
 * Slim projection of `Book` used by the `listBooks` tool. The full Book
 * carries `messages: ChatMessage[]` and `files: [...]` (tens of MB on long
 * playthroughs); the agent only needs identity + routing fields, so callers
 * pre-shape into this minimal form before injecting into FileAgentContext.
 */
export interface BookSummary {
  id: string;
  name: string;
  collectionId: string;
  lastActiveAt: number;
  /** Total chat turns in the book (= messages.length). */
  turnCount: number;
}

/**
 * Slim projection of `Collection` used by the `listCollections` tool.
 * `bookCount` and `isRoot` are derived by the executor at response time —
 * not stored here — so the same snapshot stays valid across turns.
 */
export interface CollectionSummary {
  id: string;
  name: string;
}

export type ToolCallMode = 'auto' | 'native' | 'json';

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

/** Common args present on every file-operation tool. `reason` is required at the JSON-schema layer — typed optional here so unit tests calling executeFileTool directly don't have to repeat boilerplate. */
export interface FileToolArgsBase {
  reason?: string;
}

export interface ReadFileArgs extends FileToolArgsBase {
  filename: string;
  startLine?: number;
  lineCount?: number;
}

export interface GrepArgs extends FileToolArgsBase {
  pattern: string;
  filename?: string;
  caseInsensitive?: boolean;
  maxResults?: number;
  contextLines?: number;
}

export interface SearchReplaceArgs extends FileToolArgsBase {
  filename: string;
  replacements: {
    pattern: string;
    replacement: string;
    isRegex?: boolean;
    caseInsensitive?: boolean;
    multiline?: boolean;
    expectedCount?: number;
  }[];
  expectedTotalReplacements?: number;
  dryRun?: boolean;
}

export interface ReplaceFileArgs extends FileToolArgsBase {
  filename: string;
  content: string;
}

export interface ReadSectionArgs extends FileToolArgsBase {
  filename: string;
  sectionPaths: string[];
}

export interface ReplaceSectionArgs extends FileToolArgsBase {
  filename: string;
  updates: {
    sectionPath: string;
    content: string;
    newTitle?: string;
    force?: boolean;
  }[];
}

export interface InsertSectionArgs extends FileToolArgsBase {
  filename: string;
  heading: string;
  content?: string;
  anchor?: 'prepend' | 'before' | 'after' | 'append-into';
  anchorSectionPath?: string;
}

export interface InsertIntoSectionArgs extends FileToolArgsBase {
  filename: string;
  sectionPath: string;
  content: string;
  position: 'start' | 'end';
}

export interface GetFileOutlineArgs extends FileToolArgsBase {
  filename: string;
}

export interface ReportProgressArgs {
  message: string;
}

export interface SubmitResponseArgs {
  message: string;
}

export type ChatSearchScope = 'content' | 'thought' | 'summary' | 'all';
export type ChatReadField = 'content' | 'thought' | 'logs' | 'analysis' | 'summary' | 'intent';
export type TurnLogKind = 'character' | 'world' | 'inventory' | 'quest';

export interface ListChatMessagesArgs extends FileToolArgsBase {
  limit?: number;
  before?: string;
  includeHidden?: boolean;
  /** Default false. Save turns (intent === 'save') are engine-administrative file-update turns full of XML tags — usually noise for narrative questions. Set true only when the user is asking about KB-write history itself. */
  includeSaves?: boolean;
}

export interface SearchChatMessagesArgs extends FileToolArgsBase {
  pattern: string;
  scope?: ChatSearchScope;
  caseInsensitive?: boolean;
  limit?: number;
  contextChars?: number;
  /** Default false. See ListChatMessagesArgs.includeSaves. */
  includeSaves?: boolean;
}

export interface ReadChatMessageArgs extends FileToolArgsBase {
  messageIds: string[];
  include?: ChatReadField[];
}

export interface ReadTurnLogsArgs extends FileToolArgsBase {
  messageIds?: string[];
  kinds?: TurnLogKind[];
  recent?: number;
}

/* eslint-disable-next-line @typescript-eslint/no-empty-object-type */
export interface UiMapArgs extends FileToolArgsBase {}

export interface ListBooksArgs extends FileToolArgsBase {
  /** Optional. Filter to one collection only. */
  collectionId?: string;
  /** Default 50, capped at 200. */
  limit?: number;
}

/* eslint-disable-next-line @typescript-eslint/no-empty-object-type */
export interface ListCollectionsArgs extends FileToolArgsBase {}

export interface ProposeChatReplaceArgs extends FileToolArgsBase {
  search: string;
  replace: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  intentFilter?: 'all' | GameIntent;
  roleFilter?: 'all' | 'user' | 'model';
  fieldFilter?: ChatReplaceField;
}

export type ParsedAction =
  | { action: 'readFile'; args: ReadFileArgs; callId?: string }
  | { action: 'grep'; args: GrepArgs; callId?: string }
  | { action: 'searchReplace'; args: SearchReplaceArgs; callId?: string }
  | { action: 'replaceFile'; args: ReplaceFileArgs; callId?: string }
  | { action: 'getFileOutline'; args: GetFileOutlineArgs; callId?: string }
  | { action: 'readSection'; args: ReadSectionArgs; callId?: string }
  | { action: 'replaceSection'; args: ReplaceSectionArgs; callId?: string }
  | { action: 'insertSection'; args: InsertSectionArgs; callId?: string }
  | { action: 'insertIntoSection'; args: InsertIntoSectionArgs; callId?: string }
  | { action: 'listChatMessages'; args: ListChatMessagesArgs; callId?: string }
  | { action: 'searchChatMessages'; args: SearchChatMessagesArgs; callId?: string }
  | { action: 'readChatMessage'; args: ReadChatMessageArgs; callId?: string }
  | { action: 'readTurnLogs'; args: ReadTurnLogsArgs; callId?: string }
  | { action: 'uiMap'; args: UiMapArgs; callId?: string }
  | { action: 'listBooks'; args: ListBooksArgs; callId?: string }
  | { action: 'listCollections'; args: ListCollectionsArgs; callId?: string }
  | { action: 'proposeChatReplace'; args: ProposeChatReplaceArgs; callId?: string }
  | { action: 'reportProgress'; args: ReportProgressArgs; callId?: string }
  | { action: 'submitResponse'; args: SubmitResponseArgs; callId?: string };

/** Result of executing a single file tool. */
export interface ToolExecutionResult {
  response: Record<string, unknown>;
  /** Optional info log to surface to the user (e.g. "Successfully updated X"). */
  infoLog?: string;
}
