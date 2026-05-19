import {
  FileAgentContext,
  ToolExecutionResult,
  ParsedAction,
  SearchReplaceArgs,
  ReplaceFileArgs,
  ReplaceSectionArgs,
  InsertSectionArgs,
  InsertIntoSectionArgs,
  UiMapArgs,
  ListBooksArgs,
  ListCollectionsArgs,
  ProposeChatReplaceArgs,
  Awaitable
} from './file-agent.types';
import { ROOT_COLLECTION_ID } from '@app/core/models/types';
import {
  resolveSection,
  ambiguousSectionError,
  getDescendantHeaders,
  insertSectionIntoContent,
  SectionBounds
} from './markdown-section.util';
import { detectLatexViolations, latexViolationError, sanitizeLatexToUnicode } from '@app/core/utils/latex.util';
import { dispatchKbReadTool } from '../agent-runner/tools/kb-read-tools-executor';
import { dispatchChatReadTool } from '../agent-runner/tools/chat-read-tools-executor';
import { KB_WRITE_TOOL_NAMES, READ_ONLY_REJECTION } from '../agent-runner/tools/kb-write-tools';
import { clampInt } from '../agent-runner/tools/tool-helpers';

/** Returns the content to write (original or auto-sanitized), or an error if LaTeX remains after sanitization. */
function checkLatex(content: string, label: string): { content: string } | { error: string } {
  if (!detectLatexViolations(content).length) return { content };
  const sanitized = sanitizeLatexToUnicode(content);
  const remaining = detectLatexViolations(sanitized);
  if (!remaining.length) return { content: sanitized };
  return latexViolationError(remaining, label);
}

/** Prefix every write-tool error message with this marker so the LLM cannot
 *  miss that the file was NOT modified. Paired with the structured
 *  `fileChanged: false` field. The pair makes "did this write land?"
 *  observable by either string sniffing or schema inspection. */
const NO_WRITE_PREFIX = '[NO-WRITE — file unchanged] ';

/** Build a write-tool error response that carries both the salient prefix
 *  on the error string AND the structured `fileChanged: false` flag.
 *  Use this for EVERY error path inside replaceFile / searchReplace /
 *  replaceSection / insertSection / insertIntoSection — they are all
 *  all-or-nothing semantics, so any error means the file is untouched. */
function writeError(detail: string, extras: Record<string, unknown> = {}): ToolExecutionResult {
  return { response: { error: `${NO_WRITE_PREFIX}${detail}`, fileChanged: false, ...extras } };
}

const PROPOSE_FILE_EDIT_REJECTION = 'proposeChatReplace is only available on the main agent surface (chat panel / PiP). You are currently on the file-edit surface (embedded inside the file-viewer dialog), which is scoped to a single KB file. Use submitResponse to tell the user to open the main agent console and re-issue the request there.';

const PROPOSE_NO_PROPOSER_WIRED = 'proposeChatReplace cannot be dispatched in this run — the host has not wired a chat-replace proposer. This usually means the agent was invoked from a context (test harness, dev tool) that cannot open the approval dialog. Use submitResponse to acknowledge the limitation.';

export function executeFileTool(
  action: ParsedAction,
  context: FileAgentContext
): Awaitable<ToolExecutionResult> {
  if (context.readOnly && KB_WRITE_TOOL_NAMES.has(action.action)) {
    return writeError(READ_ONLY_REJECTION);
  }

  // Read-tool dispatch — UNREACHABLE in production (FileAgentService.dispatchTool
  // intercepts read actions via super.dispatchReadTool before falling through
  // to this function). Kept here for back-compat with the standalone spec
  // (file-agent-tool-executor.spec.ts), which exercises read tools through
  // executeFileTool directly. When that spec migrates to call
  // dispatchKbReadTool / dispatchChatReadTool directly, these two lines can
  // be deleted along with the imports.
  const kbRead = dispatchKbReadTool(action, context);
  if (kbRead !== null) return kbRead;

  const chatRead = dispatchChatReadTool(action, context);
  if (chatRead !== null) return chatRead;

  // Write + UI-help + propose + flow-control are file-agent-specific for now.
  switch (action.action) {
    case 'searchReplace':
      return searchReplace(action.args, context);
    case 'replaceFile':
      return replaceFile(action.args, context);
    case 'replaceSection':
      return replaceSection(action.args, context);
    case 'insertSection':
      return insertSection(action.args, context);
    case 'insertIntoSection':
      return insertIntoSection(action.args, context);
    case 'uiMap':
      return uiMap(action.args, context);
    case 'listBooks':
      return listBooks(action.args, context);
    case 'listCollections':
      return listCollections(action.args, context);
    case 'proposeChatReplace':
      return proposeChatReplace(action.args, context);
    case 'reportProgress':
    case 'submitResponse':
      return { response: { status: 'acknowledged' } };
    default: {
      return {
        response: { error: `Unknown function: ${(action as { action: string }).action}` },
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
  if (currentContent === undefined) return writeError('File not found');

  const replacements = args.replacements;
  if (!Array.isArray(replacements) || replacements.length === 0) {
    return writeError('replacements must be a non-empty array');
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
      return writeError(`replacements[${i}].pattern is required and must be a non-empty string`);
    }
    const replacement = r.replacement;
    if (typeof replacement !== 'string') {
      return writeError(`replacements[${i}].replacement is required and must be a string (use "" to delete matches)`);
    }
    const isRegex = !!r.isRegex;
    const caseInsensitive = !!r.caseInsensitive;
    const multiline = !!r.multiline;

    let cleanReplacement = replacement;
    if (cleanReplacement && !dryRun) {
      const latexCheck = checkLatex(cleanReplacement, `replacements[${i}].replacement`);
      if ('error' in latexCheck) return writeError(latexCheck.error);
      cleanReplacement = latexCheck.content;
    }

    if (!isRegex && pattern === cleanReplacement) {
      return writeError(`replacements[${i}]: pattern and replacement are identical — this would be a no-op`);
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
      return writeError(`replacements[${i}]: invalid regex "${pattern}": ${e instanceof Error ? e.message : String(e)}`);
    }

    const matches = Array.from(currentContent.matchAll(regex));
    const count = matches.length;

    if (r.expectedCount !== undefined && count !== r.expectedCount) {
      return writeError(
        `replacements[${i}]: expectedCount mismatch for pattern "${pattern}" — expected ${r.expectedCount}, found ${count}.`,
        { found: count }
      );
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
    return writeError(
      `expectedTotalReplacements mismatch: expected ${expectedTotal}, found ${totalReplacements}.`,
      { found: totalReplacements, details: results }
    );
  }

  if (!dryRun && totalReplacements === 0) {
    return writeError(
      'No matches found for any pattern. Re-grep with the REPLACEMENT value first to check whether the file is already in the target state (a successful earlier edit will make the original pattern disappear) before retrying.',
      { details: results }
    );
  }

  if (!dryRun) {
    context.onFileReplaced(filename, currentContent);
  }

  return {
    response: {
      status: dryRun ? 'dry-run' : 'success',
      fileChanged: !dryRun,
      summary: `searchReplace in ${filename}: ${totalReplacements} replacement(s) across ${replacements.length} pattern(s).`,
      totalReplacements,
      details: results,
      totalLines: currentContent.split('\n').length
    },
    infoLog: dryRun ? undefined : `Successfully applied ${totalReplacements} replacement(s) in ${filename}`
  };
}

function replaceFile(args: ReplaceFileArgs, context: FileAgentContext): ToolExecutionResult {
  const oldContent = context.files.get(args.filename);
  if (oldContent === undefined) return writeError('File not found');
  const latexCheck = checkLatex(args.content, 'content');
  if ('error' in latexCheck) return writeError(latexCheck.error);
  const newFileContent = latexCheck.content;
  const oldLines = oldContent.split('\n').length;
  const newLines = newFileContent.split('\n').length;
  const diff = newLines - oldLines;
  const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
  context.onFileReplaced(args.filename, newFileContent);
  return {
    response: {
      status: 'success',
      fileChanged: true,
      summary: `File ${args.filename} replaced. Lines: ${oldLines} -> ${newLines} (${diffStr})`,
      totalLines: newLines
    },
    infoLog: `Successfully updated ${args.filename}`
  };
}

function replaceSection(args: ReplaceSectionArgs, context: FileAgentContext): ToolExecutionResult {
  const filename = args.filename;
  const content = context.files.get(filename);
  if (content === undefined) return writeError('File not found');

  const updates = args.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return writeError('updates must be a non-empty array');
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
      return writeError('each update entry requires a non-empty sectionPath');
    }
    if (typeof u.content !== 'string') {
      return writeError(`updates entry for "${u.sectionPath}" requires a string "content" (use "" to clear the body)`);
    }
    let body = u.content;
    if (body) {
      const latexCheck = checkLatex(body, `content (${u.sectionPath})`);
      if ('error' in latexCheck) return writeError(latexCheck.error);
      body = latexCheck.content;
    }
    const resolution = resolveSection(content, u.sectionPath);
    if (resolution.kind === 'none') {
      return writeError(`Section not found: "${u.sectionPath}". Re-call getFileOutline before retrying — an earlier edit may have renamed or moved this section, and re-firing the same path will keep failing until you re-check the current heading list.`);
    }
    if (resolution.kind === 'ambiguous') {
      const ambig = ambiguousSectionError('replace', u.sectionPath, resolution.matches);
      return writeError(ambig.error, { matches: ambig.matches });
    }
    const descendants = getDescendantHeaders(content, resolution.section);
    if (descendants.length > 0 && !u.force) {
      return writeError(
        `Section "${u.sectionPath}" contains subsections that would be permanently deleted: [${descendants.map(h => `"${h}"`).join(', ')}]. To proceed anyway, pass force: true on this update entry. Otherwise, target each child directly by path (e.g. "${u.sectionPath}>ChildName"), or use insertSection to add new subsections.`
      );
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
      fileChanged: true,
      summary: `Successfully updated ${updates.length} section(s) in ${filename}`,
      totalLines: currentLines.length
    },
    infoLog: `Successfully updated ${updates.length} section(s) in ${filename}`
  };
}

function insertSection(args: InsertSectionArgs, context: FileAgentContext): ToolExecutionResult {
  const content = context.files.get(args.filename);
  if (content === undefined) return writeError('File not found');
  if (!args.heading || !args.heading.match(/^#{1,6}\s+\S/)) {
    return writeError('heading must start with 1-6 # characters followed by text, e.g. "## New Section"');
  }
  if ((args.anchor === 'before' || args.anchor === 'after' || args.anchor === 'append-into') && !args.anchorSectionPath) {
    return writeError(`anchor "${args.anchor}" requires anchorSectionPath`);
  }
  if (args.content) {
    const firstNonEmpty = args.content.match(/^\s*(\S.*)$/m)?.[1];
    const canonical = (s: string) => s.replace(/\s+/g, ' ').trim();
    if (firstNonEmpty && canonical(firstNonEmpty) === canonical(args.heading)) {
      return writeError(`content must NOT repeat the heading line — the runtime emits "${args.heading}" from the "heading" arg, then your content directly below. Including the heading inside content produces two identical headings. Pass body content only.`);
    }
  }
  let insertBody = args.content;
  if (insertBody) {
    const latexCheck = checkLatex(insertBody, 'content');
    if ('error' in latexCheck) return writeError(latexCheck.error);
    insertBody = latexCheck.content;
  }
  const result = insertSectionIntoContent(content, args.heading, insertBody, args.anchor, args.anchorSectionPath);
  if ('error' in result) {
    const hint = result.error.startsWith('Anchor section not found')
      ? `${result.error}. Re-call getFileOutline before retrying — an earlier edit may have renamed or moved this section, and re-firing the same path will keep failing until you re-check the current heading list.`
      : result.error;
    return writeError(hint);
  }
  const oldLines = content.split('\n').length;
  context.onFileReplaced(args.filename, result.newContent);
  return {
    response: {
      status: 'success',
      fileChanged: true,
      summary: `Inserted "${args.heading}" at line ${result.insertedAtLine} in ${args.filename}. Lines: ${oldLines} -> ${result.newContent.split('\n').length}`,
      insertedAtLine: result.insertedAtLine,
      totalLines: result.newContent.split('\n').length
    },
    infoLog: `Inserted section "${args.heading}" in ${args.filename}`
  };
}

function insertIntoSection(args: InsertIntoSectionArgs, context: FileAgentContext): ToolExecutionResult {
  const filename = args.filename;
  const content = context.files.get(filename);
  if (content === undefined) return writeError('File not found');

  if (typeof args.sectionPath !== 'string' || args.sectionPath.length === 0) {
    return writeError('sectionPath is required');
  }
  if (typeof args.content !== 'string' || args.content.length === 0) {
    return writeError('content is required and must be a non-empty string');
  }
  if (args.position !== 'start' && args.position !== 'end') {
    return writeError('position must be "start" or "end"');
  }

  const resolution = resolveSection(content, args.sectionPath);
  if (resolution.kind === 'none') return writeError(`Section not found: "${args.sectionPath}". Re-call getFileOutline before retrying — an earlier edit may have renamed or moved this section, and re-firing the same path will keep failing until you re-check the current heading list.`);
  if (resolution.kind === 'ambiguous') {
    const ambig = ambiguousSectionError('replace', args.sectionPath, resolution.matches);
    return writeError(ambig.error, { matches: ambig.matches });
  }

  const latexCheck = checkLatex(args.content, `content (${args.sectionPath})`);
  if ('error' in latexCheck) return writeError(latexCheck.error);
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
      fileChanged: true,
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

async function proposeChatReplace(
  args: ProposeChatReplaceArgs,
  context: FileAgentContext
): Promise<ToolExecutionResult> {
  if ((context.surface ?? 'main') !== 'main') {
    return { response: { error: PROPOSE_FILE_EDIT_REJECTION } };
  }
  if (typeof args.search !== 'string' || args.search.length === 0) {
    return { response: { error: 'search is required and must be a non-empty string' } };
  }
  if (typeof args.replace !== 'string') {
    return { response: { error: 'replace is required and must be a string (use "" to delete matches)' } };
  }

  const proposer = context.proposers?.chatReplace;
  if (!proposer) {
    return { response: { error: PROPOSE_NO_PROPOSER_WIRED } };
  }

  const outcome = await proposer({
    search: args.search,
    replace: args.replace,
    caseSensitive: args.caseSensitive,
    wholeWord: args.wholeWord,
    regex: args.regex,
    intentFilter: args.intentFilter,
    roleFilter: args.roleFilter,
    fieldFilter: args.fieldFilter,
  });

  // Surface the outcome with explicit past-tense framing. The proposer's
  // `applied` field is structured but its name is ambiguous (could read
  // as "what would be applied"); smaller models have mis-narrated a
  // committed outcome as "please confirm in the dialog". The added
  // `status` enum and natural-language `summary` make the past tense
  // impossible to miss: the dialog is closed by the time this tool
  // returns, and whatever happened HAS happened.
  const status = outcome.cancelled ? 'cancelled' : 'committed';
  const summary = outcome.cancelled
    ? 'User cancelled the proposal dialog. NO chat messages were modified. The dialog is now closed. Do NOT ask the user to confirm — they already declined.'
    : `User confirmed the proposal dialog. ${outcome.applied!.replaceCount} replacement(s) WERE applied${outcome.divergedFromProposal ? ' (with parameters tweaked from your original proposal — see `applied` for the actually-applied values)' : ''}. The dialog is now closed and the change is committed. Do NOT ask the user to "confirm" again — that already happened.`;
  return { response: { ...outcome, status, summary } };
}
