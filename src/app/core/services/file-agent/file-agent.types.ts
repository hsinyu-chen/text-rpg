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
}

export interface ReadFileArgs {
  filename: string;
  startLine?: number;
  lineCount?: number;
}

export interface GrepArgs {
  pattern: string;
  filename?: string;
  caseInsensitive?: boolean;
  maxResults?: number;
  contextLines?: number;
}

export interface SearchReplaceArgs {
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

export interface ReplaceFileArgs {
  filename: string;
  content: string;
}

export interface ReadSectionArgs {
  filename: string;
  sectionPaths: string[];
}

export interface ReplaceSectionArgs {
  filename: string;
  updates: {
    sectionPath: string;
    content: string;
    newTitle?: string;
    force?: boolean;
  }[];
}

export interface InsertSectionArgs {
  filename: string;
  heading: string;
  content?: string;
  anchor?: 'prepend' | 'before' | 'after' | 'append-into';
  anchorSectionPath?: string;
}

export interface InsertIntoSectionArgs {
  filename: string;
  sectionPath: string;
  content: string;
  position: 'start' | 'end';
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
  | { action: 'getFileOutline'; args: { filename: string }; callId?: string }
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
