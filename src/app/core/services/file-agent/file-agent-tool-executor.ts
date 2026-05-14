import {
  FileAgentContext,
  ToolExecutionResult,
  ParsedAction,
  ReadFileArgs,
  GrepArgs,
  SearchReplaceArgs,
  ReplaceFileArgs,
  ReadSectionArgs,
  ReplaceSectionArgs,
  InsertSectionArgs,
  InsertIntoSectionArgs,
  ListChatMessagesArgs,
  SearchChatMessagesArgs,
  ReadChatMessageArgs,
  ReadTurnLogsArgs,
  UiMapArgs,
  ListBooksArgs,
  ListCollectionsArgs,
  ChatReadField,
  TurnLogKind
} from './file-agent.types';
import { ROOT_COLLECTION_ID } from '@app/core/models/types';
import type { ChatMessage } from '@app/core/models/types';
import {
  parseMarkdownOutline,
  resolveSection,
  ambiguousSectionError,
  getDescendantHeaders,
  insertSectionIntoContent,
  SectionBounds
} from './markdown-section.util';
import { detectLatexViolations, latexViolationError, sanitizeLatexToUnicode } from '@app/core/utils/latex.util';

/**
 * Coerce an LLM-supplied numeric arg into a bounded int. JSON-mode tool calls
 * are not schema-validated before reaching here, so a stringy "abc" or null
 * would slip into Math.floor → NaN and then bypass Math.min/Math.max
 * (NaN propagates through both). Treat null/undefined/non-finite as "missing,
 * use default" while still respecting an explicit 0 (e.g. contextChars: 0).
 */
function clampInt(value: unknown, min: number, max: number, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Returns the content to write (original or auto-sanitized), or an error if LaTeX remains after sanitization. */
function checkLatex(content: string, label: string): { content: string } | { error: string } {
  if (!detectLatexViolations(content).length) return { content };
  const sanitized = sanitizeLatexToUnicode(content);
  const remaining = detectLatexViolations(sanitized);
  if (!remaining.length) return { content: sanitized };
  return latexViolationError(remaining, label);
}

/** Tools that mutate files. Rejected when context.readOnly is set. */
const WRITE_ACTIONS = new Set([
  'replaceFile', 'searchReplace', 'replaceSection', 'insertSection', 'insertIntoSection'
]);

const READ_ONLY_REJECTION = 'This agent surface is read-only and cannot edit files — the user is on the main game screen, which has no editor view, so silent file mutations would be invisible to them. Do NOT retry write tools here. Use submitResponse to tell the user: open the KB editor (the file-viewer dialog from the sidebar) and re-issue the request there, where they can review and save the changes.';

export function executeFileTool(
  action: ParsedAction,
  context: FileAgentContext
): ToolExecutionResult {
  if (context.readOnly && WRITE_ACTIONS.has(action.action)) {
    return { response: { error: READ_ONLY_REJECTION } };
  }
  switch (action.action) {
    case 'readFile':
      return readFile(action.args, context);
    case 'grep':
      return grep(action.args, context);
    case 'searchReplace':
      return searchReplace(action.args, context);
    case 'replaceFile':
      return replaceFile(action.args, context);
    case 'getFileOutline':
      return getFileOutline(action.args, context);
    case 'readSection':
      return readSection(action.args, context);
    case 'replaceSection':
      return replaceSection(action.args, context);
    case 'insertSection':
      return insertSection(action.args, context);
    case 'insertIntoSection':
      return insertIntoSection(action.args, context);
    case 'listChatMessages':
      return listChatMessages(action.args, context);
    case 'searchChatMessages':
      return searchChatMessages(action.args, context);
    case 'readChatMessage':
      return readChatMessage(action.args, context);
    case 'readTurnLogs':
      return readTurnLogs(action.args, context);
    case 'uiMap':
      return uiMap(action.args, context);
    case 'listBooks':
      return listBooks(action.args, context);
    case 'listCollections':
      return listCollections(action.args, context);
    case 'reportProgress':
    case 'submitResponse':
      return { response: { status: 'acknowledged' } };
    default: {
      // Exhaustive check
      const exhaustiveCheck: never = action;
      return {
        response: { error: `Unknown function: ${(exhaustiveCheck as { action: string }).action}` },
      };
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `…(+${s.length - max} chars)`;
}

function searchReplace(args: SearchReplaceArgs, context: FileAgentContext): ToolExecutionResult {
  const filename = args.filename;
  let currentContent = context.files.get(filename);
  if (currentContent === undefined) return { response: { error: 'File not found' } };

  const replacements = args.replacements;
  if (!Array.isArray(replacements) || replacements.length === 0) {
    return { response: { error: 'replacements must be a non-empty array' } };
  }

  const dryRun = !!args.dryRun;
  const expectedTotal = args.expectedTotalReplacements;

  interface ReplacementResult {
    pattern: string;
    count: number;
    samples?: { line: number; before: string; after: string }[];
    error?: string;
  }
  const results: ReplacementResult[] = [];
  let totalReplacements = 0;

  for (let i = 0; i < replacements.length; i++) {
    const r = replacements[i];
    const pattern = r.pattern;
    if (typeof pattern !== 'string' || pattern.length === 0) {
      return { response: { error: `replacements[${i}].pattern is required and must be a non-empty string` } };
    }
    const replacement = r.replacement;
    if (typeof replacement !== 'string') {
      return { response: { error: `replacements[${i}].replacement is required and must be a string (use "" to delete matches)` } };
    }
    const isRegex = !!r.isRegex;
    const caseInsensitive = !!r.caseInsensitive;
    const multiline = !!r.multiline;

    let cleanReplacement = replacement;
    if (cleanReplacement && !dryRun) {
      const latexCheck = checkLatex(cleanReplacement, `replacements[${i}].replacement`);
      if ('error' in latexCheck) return { response: latexCheck };
      cleanReplacement = latexCheck.content;
    }

    if (!isRegex && pattern === cleanReplacement) {
      return { response: { error: `replacements[${i}]: pattern and replacement are identical — this would be a no-op` } };
    }

    const source = isRegex ? pattern : escapeRegex(pattern);
    let flags = 'g';
    if (caseInsensitive) flags += 'i';
    if (multiline) flags += 'm';

    let regex: RegExp;
    let nonGlobal: RegExp;
    try {
      regex = new RegExp(source, flags);
      nonGlobal = new RegExp(source, flags.replace('g', ''));
    } catch (e) {
      return { response: { error: `replacements[${i}]: invalid regex "${pattern}": ${e instanceof Error ? e.message : String(e)}` } };
    }

    const matches = Array.from(currentContent.matchAll(regex));
    const count = matches.length;

    if (r.expectedCount !== undefined && count !== r.expectedCount) {
      return {
        response: {
          error: `replacements[${i}]: expectedCount mismatch for pattern "${pattern}" — expected ${r.expectedCount}, found ${count}. File unchanged.`,
          found: count
        }
      };
    }

    const samples: { line: number; before: string; after: string }[] = [];
    for (const m of matches.slice(0, 3)) {
      const line = currentContent.slice(0, m.index ?? 0).split('\n').length;
      const after = m[0].replace(nonGlobal, cleanReplacement);
      samples.push({ line, before: truncate(m[0], 200), after: truncate(after, 200) });
    }

    if (count > 0 && !dryRun) {
      currentContent = currentContent.replace(regex, cleanReplacement);
    }
    totalReplacements += count;
    results.push({ pattern, count, samples: samples.length ? samples : undefined });
  }

  if (expectedTotal !== undefined && totalReplacements !== expectedTotal) {
    return {
      response: {
        error: `expectedTotalReplacements mismatch: expected ${expectedTotal}, found ${totalReplacements}. File unchanged.`,
        found: totalReplacements,
        details: results
      }
    };
  }

  if (!dryRun && totalReplacements === 0) {
    return {
      response: {
        error: 'No matches found for any pattern. File unchanged. Re-grep to confirm what should match.',
        details: results
      }
    };
  }

  if (!dryRun) {
    context.onFileReplaced(filename, currentContent);
  }

  return {
    response: {
      status: dryRun ? 'dry-run' : 'success',
      summary: `searchReplace in ${filename}: ${totalReplacements} replacement(s) across ${replacements.length} pattern(s).`,
      totalReplacements,
      details: results,
      totalLines: currentContent.split('\n').length
    },
    infoLog: dryRun ? undefined : `Successfully applied ${totalReplacements} replacement(s) in ${filename}`
  };
}

function readFile(args: ReadFileArgs, context: FileAgentContext): ToolExecutionResult {
  const content = context.files.get(args.filename);
  if (content === undefined) return { response: { error: 'File not found' } };
  const lines = content.split('\n');
  const totalLines = lines.length;
  const startLineArg = args.startLine;
  const lineCount = args.lineCount;
  if (startLineArg === undefined && lineCount === undefined) {
    return { response: { content, startLine: 1, endLine: totalLines, totalLines, truncated: false } };
  }
  const startIdx = Math.max(0, (startLineArg ?? 1) - 1);
  const endIdx = lineCount !== undefined
    ? Math.min(totalLines, startIdx + Math.max(0, lineCount))
    : totalLines;
  const sliced = lines.slice(startIdx, endIdx).join('\n');
  return {
    response: {
      content: sliced,
      startLine: startIdx + 1,
      endLine: endIdx,
      totalLines,
      truncated: endIdx < totalLines
    }
  };
}

function grep(args: GrepArgs, context: FileAgentContext): ToolExecutionResult {
  const pattern = args.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { response: { error: 'pattern is required and must be a non-empty string' } };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, args.caseInsensitive ? 'i' : '');
  } catch (e) {
    return { response: { error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` } };
  }
  const maxResults = typeof args.maxResults === 'number' && args.maxResults > 0
    ? Math.floor(args.maxResults)
    : 100;
  const contextLines = typeof args.contextLines === 'number' && args.contextLines > 0
    ? Math.min(10, Math.floor(args.contextLines))
    : 0;
  const filename = args.filename;

  let filesToSearch: [string, string][];
  if (filename) {
    const fileContent = context.files.get(filename);
    if (fileContent === undefined) return { response: { error: 'File not found' } };
    filesToSearch = [[filename, fileContent]];
  } else {
    filesToSearch = Array.from(context.files.entries());
  }

  interface Match { filename: string, line: number, text: string, before?: string[], after?: string[] }
  const matches: Match[] = [];
  let truncated = false;
  outer: for (const [fname, fileContent] of filesToSearch) {
    const lines = fileContent.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        if (matches.length >= maxResults) {
          truncated = true;
          break outer;
        }
        const m: Match = { filename: fname, line: i + 1, text: lines[i] };
        if (contextLines > 0) {
          const beforeStart = Math.max(0, i - contextLines);
          const afterEnd = Math.min(lines.length, i + 1 + contextLines);
          if (beforeStart < i) m.before = lines.slice(beforeStart, i);
          if (afterEnd > i + 1) m.after = lines.slice(i + 1, afterEnd);
        }
        matches.push(m);
      }
    }
  }
  return { response: { matches, count: matches.length, truncated } };
}

function replaceFile(args: ReplaceFileArgs, context: FileAgentContext): ToolExecutionResult {
  const oldContent = context.files.get(args.filename);
  if (oldContent === undefined) return { response: { error: 'File not found' } };
  const latexCheck = checkLatex(args.content, 'content');
  if ('error' in latexCheck) return { response: latexCheck };
  const newFileContent = latexCheck.content;
  const oldLines = oldContent.split('\n').length;
  const newLines = newFileContent.split('\n').length;
  const diff = newLines - oldLines;
  const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
  context.onFileReplaced(args.filename, newFileContent);
  return {
    response: {
      status: 'success',
      summary: `File ${args.filename} replaced. Lines: ${oldLines} -> ${newLines} (${diffStr})`,
      totalLines: newLines
    },
    infoLog: `Successfully updated ${args.filename}`
  };
}

function getFileOutline(args: { filename: string }, context: FileAgentContext): ToolExecutionResult {
  const content = context.files.get(args.filename);
  if (content === undefined) return { response: { error: 'File not found' } };
  return {
    response: {
      outline: parseMarkdownOutline(args.filename, content),
      totalLines: content.split('\n').length
    }
  };
}

function readSection(args: ReadSectionArgs, context: FileAgentContext): ToolExecutionResult {
  const filename = args.filename;
  const content = context.files.get(filename);
  if (content === undefined) return { response: { error: 'File not found' } };

  const paths = args.sectionPaths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return { response: { error: 'sectionPaths must be a non-empty array' } };
  }

  const lines = content.split('\n');
  interface SectionResult {
    path: string;
    header?: string;
    content?: string;
    startLine?: number;
    endLine?: number;
    error?: string;
    truncated?: boolean;
    note?: string;
  }
  const results: SectionResult[] = [];
  let totalLines = 0;
  const LINE_LIMIT = 500;
  let truncated = false;

  for (const path of paths) {
    const resolution = resolveSection(content, path);
    if (resolution.kind === 'none') {
      results.push({ path, error: 'Section not found' });
      continue;
    }
    if (resolution.kind === 'ambiguous') {
      results.push({ path, error: `Ambiguous path: matches ${resolution.matches.length} sections` });
      continue;
    }

    const bounds = resolution.section;
    const sectionLines = lines.slice(bounds.startLine + 1, bounds.endLine + 1);
    // Report the line range of the returned body (heading excluded), so an LLM
    // mapping content back to the file doesn't need to subtract the heading offset.
    const bodyStart = bounds.startLine + 2;

    if (totalLines + sectionLines.length > LINE_LIMIT) {
      const allowed = LINE_LIMIT - totalLines;
      if (allowed > 0) {
        results.push({
          path,
          header: bounds.headerText,
          content: sectionLines.slice(0, allowed).join('\n'),
          startLine: bodyStart,
          endLine: bodyStart + allowed - 1,
          truncated: true,
          note: `Truncated: exceeded ${LINE_LIMIT} lines total limit.`
        });
        totalLines += allowed;
      } else {
        results.push({ path, header: bounds.headerText, error: 'Skipped: already at total lines limit' });
      }
      truncated = true;
    } else if (sectionLines.length === 0) {
      // Heading with no body — omit the range entirely; reporting bodyStart..bodyStart-1
      // would be misleading, and there is no content to map back to.
      results.push({
        path,
        header: bounds.headerText,
        content: ''
      });
    } else {
      results.push({
        path,
        header: bounds.headerText,
        content: sectionLines.join('\n'),
        startLine: bodyStart,
        endLine: bounds.endLine + 1
      });
      totalLines += sectionLines.length;
    }
  }

  return {
    response: {
      sections: results,
      totalLinesRead: totalLines,
      totalLines: lines.length,
      truncated,
      note: truncated ? `Some results were truncated to fit the ${LINE_LIMIT} lines limit.` : undefined
    }
  };
}

function replaceSection(args: ReplaceSectionArgs, context: FileAgentContext): ToolExecutionResult {
  const filename = args.filename;
  const content = context.files.get(filename);
  if (content === undefined) return { response: { error: 'File not found' } };

  const updates = args.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return { response: { error: 'updates must be a non-empty array' } };
  }

  // Apply from BOTTOM to TOP so earlier startLines remain valid as we mutate.
  interface ResolvedUpdate {
    bounds: SectionBounds;
    content: string;
    newTitle?: string;
    path: string;
  }
  const resolvedUpdates: ResolvedUpdate[] = [];

  for (const u of updates) {
    if (typeof u.sectionPath !== 'string' || u.sectionPath.length === 0) {
      return { response: { error: 'each update entry requires a non-empty sectionPath' } };
    }
    if (typeof u.content !== 'string') {
      return { response: { error: `updates entry for "${u.sectionPath}" requires a string "content" (use "" to clear the body)` } };
    }
    let body = u.content;
    if (body) {
      const latexCheck = checkLatex(body, `content (${u.sectionPath})`);
      if ('error' in latexCheck) return { response: latexCheck };
      body = latexCheck.content;
    }
    const resolution = resolveSection(content, u.sectionPath);
    if (resolution.kind === 'none') {
      return { response: { error: `Section not found: "${u.sectionPath}"` } };
    }
    if (resolution.kind === 'ambiguous') {
      return { response: ambiguousSectionError('replace', u.sectionPath, resolution.matches) };
    }
    const descendants = getDescendantHeaders(content, resolution.section);
    if (descendants.length > 0 && !u.force) {
      return {
        response: {
          error: `Section "${u.sectionPath}" contains subsections that would be permanently deleted: [${descendants.map(h => `"${h}"`).join(', ')}]. To proceed anyway, pass force: true on this update entry. Otherwise, target each child directly by path (e.g. "${u.sectionPath}>ChildName"), or use insertSection to add new subsections.`
        }
      };
    }
    resolvedUpdates.push({ bounds: resolution.section, content: body, newTitle: u.newTitle, path: u.sectionPath });
  }

  // Sort by startLine descending
  resolvedUpdates.sort((a, b) => b.bounds.startLine - a.bounds.startLine);

  let currentLines = content.split('\n');
  for (const u of resolvedUpdates) {
    const b = u.bounds;
    const prefix = currentLines.slice(0, b.startLine);
    const suffix = currentLines.slice(b.endLine + 1);
    const hashes = '#'.repeat(b.level);
    const newHeaderLine = u.newTitle ? `${hashes} ${u.newTitle}` : currentLines[b.startLine];

    const mid = [newHeaderLine];
    if (u.content) mid.push(...u.content.split('\n'));

    currentLines = [...prefix, ...mid, ...suffix];
  }

  const newContent = currentLines.join('\n');
  context.onFileReplaced(filename, newContent);

  return {
    response: {
      status: 'success',
      summary: `Successfully updated ${updates.length} section(s) in ${filename}`,
      totalLines: currentLines.length
    },
    infoLog: `Successfully updated ${updates.length} section(s) in ${filename}`
  };
}

function insertSection(args: InsertSectionArgs, context: FileAgentContext): ToolExecutionResult {
  const content = context.files.get(args.filename);
  if (content === undefined) return { response: { error: 'File not found' } };
  if (!args.heading || !args.heading.match(/^#{1,6}\s+\S/)) {
    return { response: { error: 'heading must start with 1-6 # characters followed by text, e.g. "## New Section"' } };
  }
  if ((args.anchor === 'before' || args.anchor === 'after' || args.anchor === 'append-into') && !args.anchorSectionPath) {
    return { response: { error: `anchor "${args.anchor}" requires anchorSectionPath` } };
  }
  if (args.content) {
    const firstNonEmpty = args.content.match(/^\s*(\S.*)$/m)?.[1];
    const canonical = (s: string) => s.replace(/\s+/g, ' ').trim();
    if (firstNonEmpty && canonical(firstNonEmpty) === canonical(args.heading)) {
      return { response: { error: `content must NOT repeat the heading line — the runtime emits "${args.heading}" from the "heading" arg, then your content directly below. Including the heading inside content produces two identical headings. Pass body content only.` } };
    }
  }
  let insertBody = args.content;
  if (insertBody) {
    const latexCheck = checkLatex(insertBody, 'content');
    if ('error' in latexCheck) return { response: latexCheck };
    insertBody = latexCheck.content;
  }
  const result = insertSectionIntoContent(content, args.heading, insertBody, args.anchor, args.anchorSectionPath);
  if ('error' in result) return { response: { error: result.error } };
  const oldLines = content.split('\n').length;
  context.onFileReplaced(args.filename, result.newContent);
  return {
    response: {
      status: 'success',
      summary: `Inserted "${args.heading}" at line ${result.insertedAtLine} in ${args.filename}. Lines: ${oldLines} -> ${result.newContent.split('\n').length}`,
      insertedAtLine: result.insertedAtLine,
      totalLines: result.newContent.split('\n').length
    },
    infoLog: `Inserted section "${args.heading}" in ${args.filename}`
  };
}

// ===== Chat-aware tools ======================================================

const NO_CHAT_HISTORY = 'No chat history available. The agent is running outside an in-game session (e.g. world creation mode) or no turns have been played yet.';

function requireChat(context: FileAgentContext): ChatMessage[] | { response: Record<string, unknown> } {
  const msgs = context.chatMessages;
  if (!msgs || msgs.length === 0) return { response: { error: NO_CHAT_HISTORY } };
  return msgs;
}

function logKindToField(kind: TurnLogKind): keyof ChatMessage {
  switch (kind) {
    case 'character': return 'character_log';
    case 'world': return 'world_log';
    case 'inventory': return 'inventory_log';
    case 'quest': return 'quest_log';
  }
}

function listChatMessages(args: ListChatMessagesArgs, context: FileAgentContext): ToolExecutionResult {
  const chat = requireChat(context);
  if (!Array.isArray(chat)) return chat as ToolExecutionResult;

  const limit = clampInt(args.limit, 1, 100, 30);
  const includeHidden = !!args.includeHidden;
  const includeSaves = !!args.includeSaves;

  // Resolve the pagination cursor against unfiltered chat first — otherwise a
  // `before` id that exists but was filtered out (hidden / save-intent) under
  // this call's flags would 404, even though the LLM legitimately got that id
  // from a previous call with different flags. Apply filters AFTER the cut.
  let pool: ChatMessage[] = chat;
  if (args.before) {
    const cutIdx = chat.findIndex(m => m.id === args.before);
    if (cutIdx === -1) {
      return { response: { error: `before id "${args.before}" not found in current chat history` } };
    }
    pool = chat.slice(0, cutIdx);
  }
  if (!includeHidden) pool = pool.filter(m => !m.isHidden);
  if (!includeSaves) pool = pool.filter(m => m.intent !== 'save');

  const slice = pool.slice(Math.max(0, pool.length - limit));
  const filteredCounts = {
    hidden: includeHidden ? 0 : chat.filter(m => m.isHidden).length,
    save: includeSaves ? 0 : chat.filter(m => m.intent === 'save').length
  };
  const messages = slice.map(m => {
    const hasLogs = !!(m.character_log?.length || m.world_log?.length || m.inventory_log?.length || m.quest_log?.length);
    return {
      id: m.id,
      url: `app://message/${m.id}`,
      role: m.role,
      charCount: (m.content ?? '').length,
      summary: m.summary || undefined,
      intent: m.intent || undefined,
      hasLogs
    };
  });

  return {
    response: {
      messages,
      returned: messages.length,
      totalVisible: pool.length,
      totalAll: chat.length,
      olderRemaining: pool.length - messages.length,
      oldestReturnedId: messages[0]?.id,
      newestReturnedId: messages[messages.length - 1]?.id,
      filtered: filteredCounts
    }
  };
}

function searchChatMessages(args: SearchChatMessagesArgs, context: FileAgentContext): ToolExecutionResult {
  const chat = requireChat(context);
  if (!Array.isArray(chat)) return chat as ToolExecutionResult;

  if (typeof args.pattern !== 'string' || args.pattern.length === 0) {
    return { response: { error: 'pattern is required and must be a non-empty string' } };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(args.pattern, args.caseInsensitive ? 'gi' : 'g');
  } catch (e) {
    return { response: { error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` } };
  }

  const scope = args.scope ?? 'content';
  const limit = clampInt(args.limit, 1, 300, 100);
  const contextChars = clampInt(args.contextChars, 0, 400, 80);
  const includeSaves = !!args.includeSaves;
  const PER_MESSAGE_CAP = 3;

  const fieldsForScope: ('content' | 'thought' | 'summary')[] =
    scope === 'all' ? ['content', 'thought', 'summary'] : [scope];

  interface Hit { messageId: string; url: string; role: string; scope: string; snippet: string; matchIndex: number; moreInSameMessage?: number }
  const hits: Hit[] = [];
  let truncated = false;
  let suppressedSaves = 0;

  outer: for (const m of chat) {
    if (m.isHidden) continue;
    if (!includeSaves && m.intent === 'save') { suppressedSaves++; continue; }
    // Build snippets only up to PER_MESSAGE_CAP; keep counting beyond it so
    // moreInSameMessage reflects the true overflow without paying the
    // string-slice cost for every regex hit on long bodies / broad patterns.
    const perMessageHits: Hit[] = [];
    let totalMessageHits = 0;
    for (const field of fieldsForScope) {
      const raw = (m as unknown as Record<string, unknown>)[field];
      if (typeof raw !== 'string' || raw.length === 0) continue;
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(raw)) !== null) {
        if (perMessageHits.length < PER_MESSAGE_CAP) {
          const start = Math.max(0, match.index - contextChars);
          const end = Math.min(raw.length, match.index + match[0].length + contextChars);
          const snippet = (start > 0 ? '…' : '') + raw.slice(start, end) + (end < raw.length ? '…' : '');
          perMessageHits.push({ messageId: m.id, url: `app://message/${m.id}`, role: m.role, scope: field, snippet, matchIndex: match.index });
        }
        totalMessageHits++;
        if (match.index === regex.lastIndex) regex.lastIndex++;
      }
    }
    if (perMessageHits.length === 0) continue;
    if (totalMessageHits > PER_MESSAGE_CAP) {
      const last = perMessageHits[perMessageHits.length - 1];
      perMessageHits[perMessageHits.length - 1] = { ...last, moreInSameMessage: totalMessageHits - PER_MESSAGE_CAP };
    }
    for (const h of perMessageHits) {
      // Limit check BEFORE push, so `truncated` only flips when there's at
      // least one keep entry we genuinely cannot include. A pump that fills
      // hits to exactly `limit` on the last available hit ends the outer
      // loop naturally (no more matching messages → no re-entry of this
      // inner block) and truncated stays false.
      if (hits.length >= limit) { truncated = true; break outer; }
      hits.push(h);
    }
  }

  const notes: string[] = [];
  if (truncated) notes.push(`Stopped at limit=${limit}; at least one further match was not returned. Raise limit or narrow the pattern.`);
  if (suppressedSaves > 0) notes.push(`${suppressedSaves} save-intent turn(s) skipped (administrative file-update turns). Pass includeSaves:true to include them.`);

  return {
    response: {
      hits,
      count: hits.length,
      truncated,
      suppressedSaves: suppressedSaves > 0 ? suppressedSaves : undefined,
      note: notes.length ? notes.join(' ') : undefined
    }
  };
}

function readChatMessage(args: ReadChatMessageArgs, context: FileAgentContext): ToolExecutionResult {
  const chat = requireChat(context);
  if (!Array.isArray(chat)) return chat as ToolExecutionResult;

  const ids = args.messageIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return { response: { error: 'messageIds must be a non-empty array' } };
  }

  const allowed: ChatReadField[] = ['content', 'thought', 'logs', 'analysis', 'summary', 'intent'];
  const include = (args.include && args.include.length > 0)
    ? args.include.filter(f => allowed.includes(f))
    : ['content' as ChatReadField];

  interface Result {
    id: string;
    /** Clickable agent-console URL — outputting `[label](url)` in the response lets the user jump to this message. */
    url: string;
    role?: string;
    content?: string;
    thought?: string;
    analysis?: string;
    summary?: string;
    intent?: string;
    logs?: {
      character?: string[];
      world?: string[];
      inventory?: string[];
      quest?: string[];
    };
    error?: string;
  }

  const byId = new Map(chat.map(m => [m.id, m]));
  const results: Result[] = ids.map(id => {
    const m = byId.get(id);
    if (!m) return { id, url: `app://message/${id}`, error: 'Message not found' };
    const r: Result = { id, url: `app://message/${id}`, role: m.role };
    for (const f of include) {
      if (f === 'logs') {
        const logs: Result['logs'] = {};
        if (m.character_log?.length) logs.character = m.character_log;
        if (m.world_log?.length) logs.world = m.world_log;
        if (m.inventory_log?.length) logs.inventory = m.inventory_log;
        if (m.quest_log?.length) logs.quest = m.quest_log;
        r.logs = logs;
      } else {
        const v = (m as unknown as Record<string, unknown>)[f];
        if (typeof v === 'string' && v.length > 0) {
          (r as unknown as Record<string, unknown>)[f] = v;
        }
      }
    }
    return r;
  });

  return { response: { messages: results } };
}

function readTurnLogs(args: ReadTurnLogsArgs, context: FileAgentContext): ToolExecutionResult {
  const chat = requireChat(context);
  if (!Array.isArray(chat)) return chat as ToolExecutionResult;

  const kindList: TurnLogKind[] = (args.kinds && args.kinds.length > 0)
    ? args.kinds
    : ['character', 'world', 'inventory', 'quest'];

  let pool: ChatMessage[];
  if (args.messageIds && args.messageIds.length > 0) {
    const byId = new Map(chat.map(m => [m.id, m]));
    pool = [];
    const missing: string[] = [];
    for (const id of args.messageIds) {
      const m = byId.get(id);
      if (m) pool.push(m); else missing.push(id);
    }
    if (missing.length) {
      return { response: { error: `Message id(s) not found: ${missing.join(', ')}` } };
    }
  } else {
    const recent = clampInt(args.recent, 1, 100, 20);
    pool = chat.slice(Math.max(0, chat.length - recent));
  }

  interface Group { messageId: string; role: string; kind: TurnLogKind; entries: string[] }
  const groups: Group[] = [];
  for (const m of pool) {
    for (const kind of kindList) {
      const entries = m[logKindToField(kind)] as string[] | undefined;
      if (entries && entries.length > 0) {
        groups.push({ messageId: m.id, role: m.role, kind, entries });
      }
    }
  }

  return {
    response: {
      groups,
      count: groups.length,
      scanned: pool.length,
      note: groups.length === 0 ? 'No log entries found in the scanned range — none of those turns wrote to character_log / world_log / inventory_log / quest_log.' : undefined
    }
  };
}

function insertIntoSection(args: InsertIntoSectionArgs, context: FileAgentContext): ToolExecutionResult {
  const filename = args.filename;
  const content = context.files.get(filename);
  if (content === undefined) return { response: { error: 'File not found' } };

  if (typeof args.sectionPath !== 'string' || args.sectionPath.length === 0) {
    return { response: { error: 'sectionPath is required' } };
  }
  if (typeof args.content !== 'string' || args.content.length === 0) {
    return { response: { error: 'content is required and must be a non-empty string' } };
  }
  if (args.position !== 'start' && args.position !== 'end') {
    return { response: { error: 'position must be "start" or "end"' } };
  }

  const resolution = resolveSection(content, args.sectionPath);
  if (resolution.kind === 'none') return { response: { error: `Section not found: "${args.sectionPath}"` } };
  if (resolution.kind === 'ambiguous') {
    return { response: ambiguousSectionError('replace', args.sectionPath, resolution.matches) };
  }

  const latexCheck = checkLatex(args.content, `content (${args.sectionPath})`);
  if ('error' in latexCheck) return { response: latexCheck };
  const insertBody = latexCheck.content;
  const insertLines = insertBody.split('\n');

  const bounds = resolution.section;
  const lines = content.split('\n');
  const oldTotalLines = lines.length;

  let insertAt: number;
  if (args.position === 'start') {
    insertAt = bounds.startLine + 1;
  } else {
    insertAt = bounds.endLine + 1;
  }

  const newLines = [
    ...lines.slice(0, insertAt),
    ...insertLines,
    ...lines.slice(insertAt)
  ];
  const newContent = newLines.join('\n');
  context.onFileReplaced(filename, newContent);

  return {
    response: {
      status: 'success',
      summary: `Inserted ${insertLines.length} line(s) at ${args.position} of "${args.sectionPath}" in ${filename}. Lines: ${oldTotalLines} -> ${newLines.length}`,
      insertedAtLine: insertAt + 1,
      insertedLineCount: insertLines.length,
      totalLines: newLines.length
    },
    infoLog: `Inserted ${insertLines.length} line(s) into section "${args.sectionPath}" in ${filename}`
  };
}

function uiMap(_args: UiMapArgs, context: FileAgentContext): ToolExecutionResult {
  if (!context.uiMap) {
    return { response: { error: 'uiMap is not available in this context (no UI hint registry wired).' } };
  }
  return { response: { map: context.uiMap() } };
}

const NO_LIBRARY = 'Book library is not available in this context (no BookRepository wired).';

function listBooks(args: ListBooksArgs, context: FileAgentContext): ToolExecutionResult {
  const books = context.books;
  if (!books) return { response: { error: NO_LIBRARY } };

  const collectionNameById = new Map(
    (context.collections ?? []).map(c => [c.id, c.name])
  );
  const activeId = context.activeBookId ?? null;

  let pool = books;
  if (typeof args.collectionId === 'string' && args.collectionId.length > 0) {
    pool = pool.filter(b => b.collectionId === args.collectionId);
  }

  // Newest activity first — matches sidebar order and makes the agent's
  // "the elf playthrough from yesterday" intuition resolve correctly.
  const sorted = [...pool].sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  const limit = clampInt(args.limit, 1, 200, 50);
  const slice = sorted.slice(0, limit);

  return {
    response: {
      books: slice.map(b => ({
        id: b.id,
        url: `app://book/${b.id}`,
        name: b.name,
        collectionId: b.collectionId,
        collectionName: collectionNameById.get(b.collectionId) ?? null,
        lastActiveAt: new Date(b.lastActiveAt).toISOString(),
        turnCount: b.turnCount,
        isActive: b.id === activeId
      })),
      returned: slice.length,
      totalMatched: pool.length,
      totalAll: books.length,
      truncated: pool.length > slice.length
    }
  };
}

function listCollections(_args: ListCollectionsArgs, context: FileAgentContext): ToolExecutionResult {
  const collections = context.collections;
  if (!collections) return { response: { error: NO_LIBRARY } };

  const books = context.books ?? [];
  const bookCountById = new Map<string, number>();
  for (const b of books) {
    bookCountById.set(b.collectionId, (bookCountById.get(b.collectionId) ?? 0) + 1);
  }

  return {
    response: {
      collections: collections.map(c => ({
        id: c.id,
        url: `app://collection/${c.id}`,
        name: c.name,
        bookCount: bookCountById.get(c.id) ?? 0,
        isRoot: c.id === ROOT_COLLECTION_ID
      })),
      count: collections.length
    }
  };
}
