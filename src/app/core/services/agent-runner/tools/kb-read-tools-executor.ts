import type {
    ReadFileArgs,
    GrepArgs,
    GetFileOutlineArgs,
    ReadSectionArgs,
    ParsedAction,
    ToolExecutionResult,
} from '../../file-agent/file-agent.types';
import { parseMarkdownOutline, resolveSection } from '../../file-agent/markdown-section.util';
import { clampInt } from './tool-helpers';

/**
 * Context subset the kb-read tool executors need. Just the file snapshot —
 * no writes, no chat, no UI. Any agent that exposes `KB_READ_TOOLS` must
 * supply this much context.
 */
export interface KbReadContext {
    files: Map<string, string>;
}

/**
 * Dispatcher for the kb-read tool family. Returns null for actions outside
 * this family — the caller (a higher-level agent dispatcher) falls through
 * to other domain dispatchers in that case.
 */
export function dispatchKbReadTool(action: ParsedAction, context: KbReadContext): ToolExecutionResult | null {
    switch (action.action) {
        case 'readFile': return readFile(action.args, context);
        case 'grep': return grep(action.args, context);
        case 'getFileOutline': return getFileOutline(action.args, context);
        case 'readSection': return readSection(action.args, context);
        default: return null;
    }
}

function readFile(args: ReadFileArgs, context: KbReadContext): ToolExecutionResult {
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
            truncated: endIdx < totalLines,
        },
    };
}

function grep(args: GrepArgs, context: KbReadContext): ToolExecutionResult {
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
    // Use clampInt for consistency with chat-read tools and to defend against
    // non-numeric LLM hallucinations (NaN propagation through Math.floor).
    // maxResults cap of 1000 is much higher than the historical default 100
    // but matches what the docstring offers ("higher values risk filling the
    // context window") — clamping prevents abuse, defaulting preserves
    // existing behavior.
    const maxResults = clampInt(args.maxResults, 1, 1000, 100);
    const contextLines = clampInt(args.contextLines, 0, 10, 0);
    const filename = args.filename;

    let filesToSearch: [string, string][];
    if (filename) {
        const fileContent = context.files.get(filename);
        if (fileContent === undefined) return { response: { error: 'File not found' } };
        filesToSearch = [[filename, fileContent]];
    } else {
        filesToSearch = Array.from(context.files.entries());
    }

    interface Match { filename: string; line: number; text: string; before?: string[]; after?: string[] }
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

function getFileOutline(args: GetFileOutlineArgs, context: KbReadContext): ToolExecutionResult {
    const content = context.files.get(args.filename);
    if (content === undefined) return { response: { error: 'File not found' } };
    return {
        response: {
            outline: parseMarkdownOutline(args.filename, content),
            totalLines: content.split('\n').length,
        },
    };
}

function readSection(args: ReadSectionArgs, context: KbReadContext): ToolExecutionResult {
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
                    note: `Truncated: exceeded ${LINE_LIMIT} lines total limit.`,
                });
                totalLines += allowed;
            } else {
                results.push({ path, header: bounds.headerText, error: 'Skipped: already at total lines limit' });
            }
            truncated = true;
        } else if (sectionLines.length === 0) {
            results.push({
                path,
                header: bounds.headerText,
                content: '',
            });
        } else {
            results.push({
                path,
                header: bounds.headerText,
                content: sectionLines.join('\n'),
                startLine: bodyStart,
                endLine: bounds.endLine + 1,
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
            note: truncated ? `Some results were truncated to fit the ${LINE_LIMIT} lines limit.` : undefined,
        },
    };
}
