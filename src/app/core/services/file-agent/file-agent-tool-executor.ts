import {
  FileAgentContext,
  ToolExecutionResult,
  ParsedAction,
  ReadFileArgs,
  GrepArgs,
  SearchReplaceArgs,
  ReplaceFileArgs,
  ReplaceSectionArgs,
  ReadMultipleSectionsArgs,
  ReplaceMultipleSectionsArgs,
  BatchSearchReplaceArgs
} from './file-agent.types';
import {
  parseMarkdownOutline,
  resolveSection,
  ambiguousSectionError
} from './markdown-section.util';

export function executeFileTool(
  action: ParsedAction,
  context: FileAgentContext
): ToolExecutionResult {
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
    case 'readMultipleSections':
      return readMultipleSections(action.args, context);
    case 'replaceMultipleSections':
      return replaceMultipleSections(action.args, context);
    case 'batchSearchReplace':
      return batchSearchReplace(action.args, context);
    case 'reportProgress':
    case 'submitResponse':
      return { response: { status: 'acknowledged' } };
    default: {
      // Exhaustive check
      const exhaustiveCheck: never = action;
      return { response: { error: `Unknown function: ${(exhaustiveCheck as any).action}` } };
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
  const content = context.files.get(filename);
  if (content === undefined) return { response: { error: 'File not found' } };

  const pattern = args.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { response: { error: 'pattern is required and must be a non-empty string' } };
  }
  const replacement = args.replacement;
  if (typeof replacement !== 'string') {
    return { response: { error: 'replacement is required and must be a string (use "" to delete matches)' } };
  }
  const isRegex = !!args.isRegex;
  const caseInsensitive = !!args.caseInsensitive;
  const multiline = !!args.multiline;
  const dryRun = !!args.dryRun;
  const expectedReplacements = args.expectedReplacements;

  if (!isRegex && pattern === replacement) {
    return { response: { error: 'pattern and replacement are identical — this would be a no-op' } };
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
    return { response: { error: `Invalid regex: ${e instanceof Error ? e.message : String(e)}` } };
  }

  const allMatches = Array.from(content.matchAll(regex));
  const totalMatches = allMatches.length;

  if (totalMatches === 0) {
    return { response: { error: 'No matches found for pattern. File unchanged. Re-grep with the same pattern to confirm what should match.', replacements: 0 } };
  }

  if (expectedReplacements !== undefined && totalMatches !== expectedReplacements) {
    return {
      response: {
        error: `expectedReplacements mismatch: expected ${expectedReplacements}, found ${totalMatches}. File unchanged. Re-grep to confirm the actual count, then retry with the correct expectedReplacements (or omit it to proceed unchecked).`,
        replacements: totalMatches
      }
    };
  }

  const samples: { line: number, before: string, after: string }[] = [];
  for (const m of allMatches.slice(0, 5)) {
    const line = content.slice(0, m.index ?? 0).split('\n').length;
    const after = m[0].replace(nonGlobal, replacement);
    samples.push({ line, before: truncate(m[0], 200), after: truncate(after, 200) });
  }

  if (dryRun) {
    return {
      response: {
        status: 'dry-run',
        replacements: totalMatches,
        samples,
        totalLines: content.split('\n').length,
        note: 'Dry run only — file unchanged. Re-call without dryRun to apply.'
      }
    };
  }

  const newContent = content.replace(regex, replacement);
  const oldLines = content.split('\n').length;
  const newLines = newContent.split('\n').length;
  const diff = newLines - oldLines;
  const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
  context.onFileReplaced(filename, newContent);
  return {
    response: {
      status: 'success',
      summary: `searchReplace in ${filename}: ${totalMatches} replacement(s). Lines: ${oldLines} -> ${newLines} (${diffStr})`,
      replacements: totalMatches,
      samples,
      totalLines: newLines
    },
    infoLog: `Successfully applied ${totalMatches} replacement(s) in ${filename}`
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
  const oldLines = oldContent.split('\n').length;
  const newLines = args.content.split('\n').length;
  const diff = newLines - oldLines;
  const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
  context.onFileReplaced(args.filename, args.content);
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

function readSection(args: { filename: string, sectionPath: string }, context: FileAgentContext): ToolExecutionResult {
  const content = context.files.get(args.filename);
  if (content === undefined) return { response: { error: 'File not found' } };
  const resolution = resolveSection(content, args.sectionPath);
  if (resolution.kind === 'none') return { response: { error: 'Section not found' } };
  if (resolution.kind === 'ambiguous') {
    return { response: ambiguousSectionError('read', args.sectionPath, resolution.matches) };
  }
  const bounds = resolution.section;
  const lines = content.split('\n');
  const sectionContent = lines.slice(bounds.startLine + 1, bounds.endLine + 1).join('\n');
  return {
    response: {
      header: bounds.headerText,
      content: sectionContent,
      startLine: bounds.startLine + 1,
      endLine: bounds.endLine + 1,
      totalLines: lines.length
    }
  };
}

function replaceSection(args: ReplaceSectionArgs, context: FileAgentContext): ToolExecutionResult {
  const content = context.files.get(args.filename);
  if (content === undefined) return { response: { error: 'File not found' } };
  const resolution = resolveSection(content, args.sectionPath);
  if (resolution.kind === 'none') return { response: { error: 'Section not found' } };
  if (resolution.kind === 'ambiguous') {
    return { response: ambiguousSectionError('replace', args.sectionPath, resolution.matches) };
  }
  const bounds = resolution.section;
  const lines = content.split('\n');
  const prefix = lines.slice(0, bounds.startLine);
  const suffix = lines.slice(bounds.endLine + 1);
  const hashes = '#'.repeat(bounds.level);
  const newHeaderLine = args.newTitle ? `${hashes} ${args.newTitle}` : lines[bounds.startLine];
  const newFileLines = [...prefix, newHeaderLine];
  if (args.content) newFileLines.push(args.content);
  newFileLines.push(...suffix);
  const newContent = newFileLines.join('\n');
  const oldSectionLines = (bounds.endLine - bounds.startLine);
  const newSectionLines = args.content ? args.content.split('\n').length : 0;
  const diff = newSectionLines - oldSectionLines;
  const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
  context.onFileReplaced(args.filename, newContent);
  return {
    response: {
      status: 'success',
      summary: `Section ${args.sectionPath} replaced. Lines: ${oldSectionLines} -> ${newSectionLines} (${diffStr})`,
      startLine: bounds.startLine + 1,
      endLine: bounds.startLine + 1 + newSectionLines,
      totalLines: newFileLines.length
    },
    infoLog: `Successfully updated section ${args.sectionPath} in ${args.filename}`
  };
}

function readMultipleSections(args: ReadMultipleSectionsArgs, context: FileAgentContext): ToolExecutionResult {
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

    if (totalLines + sectionLines.length > LINE_LIMIT) {
      const allowed = LINE_LIMIT - totalLines;
      if (allowed > 0) {
        results.push({
          path,
          header: bounds.headerText,
          content: sectionLines.slice(0, allowed).join('\n'),
          truncated: true,
          note: `Truncated: exceeded ${LINE_LIMIT} lines total limit.`
        });
        totalLines += allowed;
      } else {
        results.push({ path, header: bounds.headerText, error: 'Skipped: already at total lines limit' });
      }
      truncated = true;
    } else {
      results.push({
        path,
        header: bounds.headerText,
        content: sectionLines.join('\n')
      });
      totalLines += sectionLines.length;
    }
  }

  return {
    response: {
      sections: results,
      totalLinesRead: totalLines,
      truncated,
      note: truncated ? `Some results were truncated to fit the ${LINE_LIMIT} lines limit.` : undefined
    }
  };
}

function replaceMultipleSections(args: ReplaceMultipleSectionsArgs, context: FileAgentContext): ToolExecutionResult {
  const filename = args.filename;
  const content = context.files.get(filename);
  if (content === undefined) return { response: { error: 'File not found' } };

  const updates = args.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return { response: { error: 'updates must be a non-empty array' } };
  }

  // To handle multiple replacements correctly, we must apply them in a way that
  // doesn't invalidate subsequent header searches.
  // Safest way: apply from BOTTOM to TOP.
  interface ResolvedUpdate {
    bounds: import('./markdown-section.util').SectionBounds;
    content: string;
    newTitle?: string;
    path: string;
  }
  const resolvedUpdates: ResolvedUpdate[] = [];

  for (const u of updates) {
    const resolution = resolveSection(content, u.sectionPath);
    if (resolution.kind !== 'ok') {
      return { response: { error: `Failed to resolve path "${u.sectionPath}": ${resolution.kind}` } };
    }
    resolvedUpdates.push({ bounds: resolution.section, content: u.content, newTitle: u.newTitle, path: u.sectionPath });
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
      summary: `Successfully updated ${updates.length} sections in ${filename}`,
      totalLines: currentLines.length
    },
    infoLog: `Successfully updated ${updates.length} sections in ${filename}`
  };
}

function batchSearchReplace(args: BatchSearchReplaceArgs, context: FileAgentContext): ToolExecutionResult {
  const filename = args.filename;
  let currentContent = context.files.get(filename);
  if (currentContent === undefined) return { response: { error: 'File not found' } };

  const replacements = args.replacements;
  const dryRun = !!args.dryRun;
  const expectedTotal = args.expectedTotalReplacements;

  interface ReplacementResult { pattern: string; count: number }
  const results: ReplacementResult[] = [];
  let totalReplacements = 0;

  for (const r of replacements) {
    const pattern = r.pattern;
    const replacement = r.replacement;
    const isRegex = !!r.isRegex;
    const caseInsensitive = !!r.caseInsensitive;
    const multiline = !!r.multiline;

    const source = isRegex ? pattern : escapeRegex(pattern);
    let flags = 'g';
    if (caseInsensitive) flags += 'i';
    if (multiline) flags += 'm';

    try {
      const regex = new RegExp(source, flags);
      const matches = Array.from(currentContent.matchAll(regex));
      if (matches.length > 0) {
        totalReplacements += matches.length;
        if (!dryRun) {
          currentContent = currentContent.replace(regex, replacement);
        }
        results.push({ pattern, count: matches.length });
      } else {
        results.push({ pattern, count: 0 });
      }
    } catch (e) {
      return { response: { error: `Invalid pattern "${pattern}": ${e}` } };
    }
  }

  if (expectedTotal !== undefined && totalReplacements !== expectedTotal) {
    return { response: { error: `Total replacements mismatch: expected ${expectedTotal}, found ${totalReplacements}. File unchanged.`, found: totalReplacements } };
  }

  if (!dryRun) {
    context.onFileReplaced(filename, currentContent);
  }

  return {
    response: {
      status: dryRun ? 'dry-run' : 'success',
      totalReplacements,
      details: results,
      totalLines: currentContent.split('\n').length
    },
    infoLog: dryRun ? undefined : `Successfully applied batch search-replace in ${filename} (${totalReplacements} changes)`
  };
}
