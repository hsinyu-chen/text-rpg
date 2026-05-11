import type { ChatMessage } from '@app/core/models/types';

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
  | { action: 'reportProgress'; args: ReportProgressArgs; callId?: string }
  | { action: 'submitResponse'; args: SubmitResponseArgs; callId?: string };

/** Result of executing a single file tool. */
export interface ToolExecutionResult {
  response: Record<string, unknown>;
  /** Optional info log to surface to the user (e.g. "Successfully updated X"). */
  infoLog?: string;
}
