export interface FileAgentContext {
  files: Map<string, string>;
  onFileReplaced: (filename: string, content: string) => void;
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
  | { action: 'reportProgress'; args: ReportProgressArgs; callId?: string }
  | { action: 'submitResponse'; args: SubmitResponseArgs; callId?: string };

/** Result of executing a single file tool. */
export interface ToolExecutionResult {
  response: Record<string, unknown>;
  /** Optional info log to surface to the user (e.g. "Successfully updated X"). */
  infoLog?: string;
}
