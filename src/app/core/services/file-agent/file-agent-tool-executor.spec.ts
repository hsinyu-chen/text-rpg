import { describe, expect, it, vi } from 'vitest';
import { executeFileTool } from './file-agent-tool-executor';
import type { FileAgentContext, ParsedAction } from './file-agent.types';
import type { ChatMessage } from '@app/core/models/types';

function makeContext(files: Record<string, string>, chatMessages?: ChatMessage[]): {
  context: FileAgentContext;
  onFileReplaced: ReturnType<typeof vi.fn>;
} {
  const map = new Map<string, string>(Object.entries(files));
  const onFileReplaced = vi.fn((filename: string, content: string) => {
    map.set(filename, content);
  });
  return { context: { files: map, onFileReplaced, chatMessages }, onFileReplaced };
}

function run(action: ParsedAction, ctx: FileAgentContext) {
  return executeFileTool(action, ctx);
}

describe('executeFileTool dispatch', () => {
  it('acknowledges reportProgress / submitResponse without touching files', () => {
    const { context, onFileReplaced } = makeContext({});
    expect(run({ action: 'reportProgress', args: { message: 'x' } }, context).response).toEqual({ status: 'acknowledged' });
    expect(run({ action: 'submitResponse', args: { message: 'x' } }, context).response).toEqual({ status: 'acknowledged' });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  it('rejects every write tool when context.readOnly is set, with a message redirecting the user to the editor', () => {
    const ctx = makeContext({ 'a.md': '# A\nbody' });
    ctx.context.readOnly = true;
    const writeActions: { action: ParsedAction['action']; args: Record<string, unknown> }[] = [
      { action: 'replaceFile', args: { filename: 'a.md', content: 'x' } },
      { action: 'searchReplace', args: { filename: 'a.md', replacements: [{ pattern: 'body', replacement: 'new' }] } },
      { action: 'replaceSection', args: { filename: 'a.md', updates: [{ sectionPath: 'A', content: 'x' }] } },
      { action: 'insertSection', args: { filename: 'a.md', heading: '## X', content: 'x' } },
      { action: 'insertIntoSection', args: { filename: 'a.md', sectionPath: 'A', content: 'x', position: 'end' } }
    ];
    for (const a of writeActions) {
      const r = run(a as ParsedAction, ctx.context);
      expect(r.response).toMatchObject({ error: expect.stringMatching(/read-only.*KB editor/) });
    }
    expect(ctx.onFileReplaced).not.toHaveBeenCalled();
  });

  it('still allows read tools when context.readOnly is set', () => {
    const ctx = makeContext({ 'a.md': 'hello' });
    ctx.context.readOnly = true;
    expect(run({ action: 'readFile', args: { filename: 'a.md' } }, ctx.context).response).toMatchObject({ content: 'hello' });
    expect(run({ action: 'grep', args: { pattern: 'hel' } }, ctx.context).response).toMatchObject({ count: 1 });
    expect(run({ action: 'getFileOutline', args: { filename: 'a.md' } }, ctx.context).response).toMatchObject({ outline: expect.any(Array) });
  });
});

describe('readFile', () => {
  it('errors when file is missing', () => {
    const { context } = makeContext({});
    const r = run({ action: 'readFile', args: { filename: 'missing.md' } }, context);
    expect(r.response).toMatchObject({ error: 'File not found' });
  });

  it('reads full file when no slice args', () => {
    const { context } = makeContext({ 'a.md': 'l1\nl2\nl3' });
    const r = run({ action: 'readFile', args: { filename: 'a.md' } }, context);
    expect(r.response).toMatchObject({ content: 'l1\nl2\nl3', startLine: 1, endLine: 3, totalLines: 3, truncated: false });
  });

  it('slices by startLine + lineCount and flags truncated when more remains', () => {
    const { context } = makeContext({ 'a.md': 'l1\nl2\nl3\nl4' });
    const r = run({ action: 'readFile', args: { filename: 'a.md', startLine: 2, lineCount: 2 } }, context);
    expect(r.response).toMatchObject({ content: 'l2\nl3', startLine: 2, endLine: 3, truncated: true });
  });
});

describe('grep', () => {
  it('errors when pattern is empty', () => {
    const { context } = makeContext({ 'a.md': 'foo' });
    const r = run({ action: 'grep', args: { pattern: '' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/pattern is required/) });
  });

  it('errors when regex is invalid', () => {
    const { context } = makeContext({ 'a.md': 'foo' });
    const r = run({ action: 'grep', args: { pattern: '(' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/Invalid regex/) });
  });

  it('searches across all files when no filename given', () => {
    const { context } = makeContext({ 'a.md': 'apple\nbanana', 'b.md': 'apricot' });
    const r = run({ action: 'grep', args: { pattern: 'ap' } }, context);
    expect(r.response).toMatchObject({ count: 2 });
  });

  it('respects maxResults and emits truncated flag', () => {
    const { context } = makeContext({ 'a.md': 'x\nx\nx\nx' });
    const r = run({ action: 'grep', args: { pattern: 'x', maxResults: 2 } }, context);
    expect(r.response).toMatchObject({ count: 2, truncated: true });
  });

  it('returns before/after context when contextLines > 0', () => {
    const { context } = makeContext({ 'a.md': 'A\nB\nMATCH\nC\nD' });
    const r = run({ action: 'grep', args: { pattern: 'MATCH', contextLines: 1 } }, context);
    expect(r.response).toMatchObject({ matches: [{ line: 3, before: ['B'], after: ['C'] }] });
  });
});

describe('searchReplace', () => {
  it('errors when file is missing', () => {
    const { context } = makeContext({});
    const r = run({ action: 'searchReplace', args: { filename: 'x.md', replacements: [{ pattern: 'a', replacement: 'b' }] } }, context);
    expect(r.response).toMatchObject({ error: 'File not found' });
  });

  it('rejects no-op replacement (pattern equals replacement, non-regex)', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': 'hello' });
    const r = run({ action: 'searchReplace', args: { filename: 'a.md', replacements: [{ pattern: 'hi', replacement: 'hi' }] } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/no-op/) });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  it('errors and leaves file unchanged on expectedCount mismatch', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': 'foo foo' });
    const r = run({ action: 'searchReplace', args: { filename: 'a.md', replacements: [{ pattern: 'foo', replacement: 'bar', expectedCount: 5 }] } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/expectedCount mismatch/), found: 2 });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  it('dry-run returns counts without writing', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': 'foo foo' });
    const r = run({ action: 'searchReplace', args: { filename: 'a.md', replacements: [{ pattern: 'foo', replacement: 'bar' }], dryRun: true } }, context);
    expect(r.response).toMatchObject({ status: 'dry-run', totalReplacements: 2 });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  it('applies multiple replacements sequentially and writes the final content', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': 'foo bar' });
    const r = run({ action: 'searchReplace', args: { filename: 'a.md', replacements: [{ pattern: 'foo', replacement: 'FOO' }, { pattern: 'bar', replacement: 'BAR' }] } }, context);
    expect(r.response).toMatchObject({ status: 'success', totalReplacements: 2 });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', 'FOO BAR');
  });

  it('errors and leaves file unchanged on expectedTotalReplacements mismatch', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': 'foo bar' });
    const r = run({ action: 'searchReplace', args: { filename: 'a.md', replacements: [{ pattern: 'foo', replacement: 'FOO' }, { pattern: 'bar', replacement: 'BAR' }], expectedTotalReplacements: 5 } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/expectedTotalReplacements mismatch/), found: 2 });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  it('errors with "No matches found" when nothing matches and not in dry-run mode', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': 'foo bar' });
    const r = run({ action: 'searchReplace', args: { filename: 'a.md', replacements: [{ pattern: 'absent', replacement: 'present' }] } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/No matches found/) });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  it('treats pattern as a regex when isRegex=true', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': 'one1 two2 three3' });
    const r = run({ action: 'searchReplace', args: { filename: 'a.md', replacements: [{ pattern: '\\d', replacement: '#', isRegex: true }] } }, context);
    expect(r.response).toMatchObject({ status: 'success', totalReplacements: 3 });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', 'one# two# three#');
  });

  it('treats pattern as literal when isRegex is omitted (regex chars do not match)', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': 'one1 two2 plain\\d' });
    const r = run({ action: 'searchReplace', args: { filename: 'a.md', replacements: [{ pattern: '\\d', replacement: '#' }] } }, context);
    expect(r.response).toMatchObject({ status: 'success', totalReplacements: 1 });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', 'one1 two2 plain#');
  });
});

describe('replaceFile', () => {
  it('errors when file is missing', () => {
    const { context } = makeContext({});
    const r = run({ action: 'replaceFile', args: { filename: 'x.md', content: 'hi' } }, context);
    expect(r.response).toMatchObject({ error: 'File not found' });
  });

  it('writes new content and reports line delta', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': 'one\ntwo' });
    const r = run({ action: 'replaceFile', args: { filename: 'a.md', content: 'one\ntwo\nthree' } }, context);
    expect(r.response).toMatchObject({ status: 'success', totalLines: 3, summary: expect.stringMatching(/2 -> 3/) });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', 'one\ntwo\nthree');
  });
});

describe('getFileOutline', () => {
  it('errors when file is missing', () => {
    const { context } = makeContext({});
    const r = run({ action: 'getFileOutline', args: { filename: 'x.md' } }, context);
    expect(r.response).toMatchObject({ error: 'File not found' });
  });

  it('returns the parsed heading list', () => {
    const md = ['# Top', 'body', '## Sub'].join('\n');
    const { context } = makeContext({ 'a.md': md });
    const r = run({ action: 'getFileOutline', args: { filename: 'a.md' } }, context);
    expect(r.response).toMatchObject({
      outline: [
        { level: 1, text: 'Top', lineNumber: 1 },
        { level: 2, text: 'Sub', lineNumber: 3 },
      ],
      totalLines: 3,
    });
  });
});

describe('readSection', () => {
  it('errors with file not found', () => {
    const { context } = makeContext({});
    const r = run({ action: 'readSection', args: { filename: 'x.md', sectionPaths: ['A'] } }, context);
    expect(r.response).toMatchObject({ error: 'File not found' });
  });

  it('errors when sectionPaths is empty', () => {
    const { context } = makeContext({ 'a.md': '# A' });
    const r = run({ action: 'readSection', args: { filename: 'a.md', sectionPaths: [] } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/non-empty array/) });
  });

  it('reports per-section errors for not-found / ambiguous paths', () => {
    const md = ['# A', '## Same', '# B', '## Same'].join('\n');
    const { context } = makeContext({ 'a.md': md });
    const r = run({ action: 'readSection', args: { filename: 'a.md', sectionPaths: ['Missing', 'Same'] } }, context);
    expect(r.response).toMatchObject({
      sections: [
        { path: 'Missing', error: 'Section not found' },
        { path: 'Same', error: expect.stringMatching(/Ambiguous/) },
      ],
    });
  });

  it('returns body without the heading line and uses 1-indexed line numbers that match the body', () => {
    const md = ['# A', 'a-body-1', 'a-body-2', '# B'].join('\n');
    const { context } = makeContext({ 'a.md': md });
    const r = run({ action: 'readSection', args: { filename: 'a.md', sectionPaths: ['A'] } }, context);
    expect(r.response).toMatchObject({
      sections: [{ content: 'a-body-1\na-body-2', startLine: 2, endLine: 3 }],
    });
  });

  it('omits startLine/endLine when the section has no body', () => {
    const md = ['# A', '# B'].join('\n');
    const { context } = makeContext({ 'a.md': md });
    const r = run({ action: 'readSection', args: { filename: 'a.md', sectionPaths: ['A'] } }, context);
    const sections = (r.response as { sections: Record<string, unknown>[] }).sections;
    expect(sections[0]).toMatchObject({ path: 'A', content: '' });
    expect(sections[0]['startLine']).toBeUndefined();
    expect(sections[0]['endLine']).toBeUndefined();
  });

  // Regression for `# 格式定義` in blank_world_zh/3.人物狀態.md: a top-level section
  // wrapping a format-spec doc inside a fence. The fenced ### lines must be
  // returned verbatim as part of the body, and endLine must extend past them.
  it('returns the whole fenced block as body without splitting on fake headings inside', () => {
    const md = [
      '# 格式定義',
      '',
      '```',
      '### fake-1',
      '- entry',
      '### fake-2',
      '```',
      '',
      '---',
      '',
      '# Next Real',
    ].join('\n');
    const { context } = makeContext({ 'a.md': md });
    const r = run({ action: 'readSection', args: { filename: 'a.md', sectionPaths: ['格式定義'] } }, context);
    const sections = (r.response as { sections: { content: string; startLine: number; endLine: number }[] }).sections;
    expect(sections).toHaveLength(1);
    expect(sections[0].startLine).toBe(2);
    expect(sections[0].endLine).toBe(9);
    expect(sections[0].content).toContain('### fake-1');
    expect(sections[0].content).toContain('### fake-2');
    expect(sections[0].content.endsWith('---')).toBe(true);
  });
});

describe('replaceSection', () => {
  it('rejects when section has descendants and force is omitted', () => {
    const md = ['# A', '## A1', 'aa', '# B'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'replaceSection', args: { filename: 'a.md', updates: [{ sectionPath: 'A', content: 'new body' }] } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/contains subsections/) });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  it('replaces a leaf section body in place', () => {
    const md = ['# A', 'old', '# B', 'b'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'replaceSection', args: { filename: 'a.md', updates: [{ sectionPath: 'A', content: 'new' }] } }, context);
    expect(r.response).toMatchObject({ status: 'success' });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\nnew\n# B\nb');
  });

  it('renames the heading when newTitle is provided', () => {
    const md = ['## Old', 'body'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'replaceSection', args: { filename: 'a.md', updates: [{ sectionPath: 'Old', content: 'body', newTitle: 'New' }] } }, context);
    expect(r.response).toMatchObject({ status: 'success' });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '## New\nbody');
  });

  it('clears body when content is empty string', () => {
    const md = ['# A', 'old', '# B'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'replaceSection', args: { filename: 'a.md', updates: [{ sectionPath: 'A', content: '' }] } }, context);
    expect(r.response).toMatchObject({ status: 'success' });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\n# B');
  });

  it('applies multiple updates bottom-up so earlier indices stay valid', () => {
    const md = ['# A', 'a', '# B', 'b', '# C', 'c'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'replaceSection', args: { filename: 'a.md', updates: [
      { sectionPath: 'A', content: 'A-new line one\nA-new line two' },
      { sectionPath: 'C', content: 'C-new' },
    ] } }, context);
    expect(r.response).toMatchObject({ status: 'success' });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\nA-new line one\nA-new line two\n# B\nb\n# C\nC-new');
  });

  it('aborts the whole call when one path is not found (atomicity)', () => {
    const md = ['# A', 'a', '# B', 'b'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'replaceSection', args: { filename: 'a.md', updates: [
      { sectionPath: 'A', content: 'new' },
      { sectionPath: 'Missing', content: 'x' },
    ] } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/Section not found.*Missing/) });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  it('with force=true, deletes child subsections', () => {
    const md = ['# A', '## A1', 'aa', '## A2', '# B'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'replaceSection', args: { filename: 'a.md', updates: [{ sectionPath: 'A', content: 'flattened', force: true }] } }, context);
    expect(r.response).toMatchObject({ status: 'success' });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\nflattened\n# B');
  });

  // Regression: a section whose body is entirely a fenced code/spec block must
  // not trip the "contains subsections" guard, because the ### inside the fence
  // are not real children.
  it('replaces a section whose body is a fenced spec block without requiring force', () => {
    const md = [
      '# 格式定義',
      '```',
      '### fake-1',
      '### fake-2',
      '```',
      '# Next',
    ].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({
      action: 'replaceSection',
      args: { filename: 'a.md', updates: [{ sectionPath: '格式定義', content: 'new spec' }] },
    }, context);
    expect(r.response).toMatchObject({ status: 'success' });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# 格式定義\nnew spec\n# Next');
  });
});

describe('insertSection', () => {
  it('errors when heading is malformed', () => {
    const { context } = makeContext({ 'a.md': '# A' });
    const r = run({ action: 'insertSection', args: { filename: 'a.md', heading: 'no hashes' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/heading must start with/) });
  });

  it('errors when before/after lacks anchorSectionPath', () => {
    const { context } = makeContext({ 'a.md': '# A' });
    const r = run({ action: 'insertSection', args: { filename: 'a.md', heading: '## X', anchor: 'before' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/requires anchorSectionPath/) });
  });

  it('appends to end-of-file when no anchor', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': '# A\nbody' });
    const r = run({ action: 'insertSection', args: { filename: 'a.md', heading: '## New', content: 'b' } }, context);
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\nbody\n\n## New\nb');
    expect(r.response).toMatchObject({ status: 'success', insertedAtLine: 4 });
  });

  it('inserts before an anchor section', () => {
    const md = ['# A', 'a', '# B'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'insertSection', args: { filename: 'a.md', heading: '# Mid', content: 'm', anchor: 'before', anchorSectionPath: 'B' } }, context);
    expect(r.response).toMatchObject({ status: 'success' });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\na\n# Mid\nm\n\n# B');
  });

  it('errors when content repeats the heading line (would duplicate the heading)', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': '# A' });
    const r = run({
      action: 'insertSection',
      args: { filename: 'a.md', heading: '## New', content: '## New\nbody', anchor: 'after', anchorSectionPath: 'A' },
    }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/must NOT repeat the heading/) });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  it('tolerates leading blank lines in content before checking heading duplication', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': '# A' });
    const r = run({
      action: 'insertSection',
      args: { filename: 'a.md', heading: '## New', content: '\n## New\nbody', anchor: 'after', anchorSectionPath: 'A' },
    }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/must NOT repeat the heading/) });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  it('detects heading duplication despite different internal whitespace', () => {
    const { context, onFileReplaced } = makeContext({ 'a.md': '# A' });
    const r = run({
      action: 'insertSection',
      args: { filename: 'a.md', heading: '## New Section', content: '##  New   Section\nbody', anchor: 'after', anchorSectionPath: 'A' },
    }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/must NOT repeat the heading/) });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });

  // Regression: an anchorSectionPath that only matches a heading INSIDE a
  // fenced block must not be treated as a real anchor.
  it('errors when anchorSectionPath only appears inside a fenced block', () => {
    const md = ['# Real', '```', '## OnlyInFence', '```'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({
      action: 'insertSection',
      args: { filename: 'a.md', heading: '## X', content: 'x', anchor: 'after', anchorSectionPath: 'OnlyInFence' },
    }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/not found/) });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });
});

describe('insertIntoSection', () => {
  it('errors when content is empty', () => {
    const { context } = makeContext({ 'a.md': '# A' });
    const r = run({ action: 'insertIntoSection', args: { filename: 'a.md', sectionPath: 'A', content: '', position: 'start' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/non-empty string/) });
  });

  it('errors when position is invalid', () => {
    const { context } = makeContext({ 'a.md': '# A' });
    const r = run({ action: 'insertIntoSection', args: { filename: 'a.md', sectionPath: 'A', content: 'x', position: 'middle' as unknown as 'start' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/position must be/) });
  });

  it('inserts right after the heading line when position=start', () => {
    const md = ['# A', 'existing', '# B'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'insertIntoSection', args: { filename: 'a.md', sectionPath: 'A', content: 'new-first', position: 'start' } }, context);
    expect(r.response).toMatchObject({ status: 'success' });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\nnew-first\nexisting\n# B');
  });

  it('inserts after all body and child sections when position=end', () => {
    const md = ['# A', '## A1', 'aa-body', '# B'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'insertIntoSection', args: { filename: 'a.md', sectionPath: 'A', content: 'tail', position: 'end' } }, context);
    expect(r.response).toMatchObject({ status: 'success' });
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\n## A1\naa-body\ntail\n# B');
  });

  it('errors with the ambiguous-path shape when path matches multiple sections', () => {
    const md = ['# A', '## Same', '# B', '## Same'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    const r = run({ action: 'insertIntoSection', args: { filename: 'a.md', sectionPath: 'Same', content: 'x', position: 'start' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/Ambiguous sectionPath/), matches: expect.any(Array) });
    expect(onFileReplaced).not.toHaveBeenCalled();
  });
});

// ===== Chat-aware tools ======================================================

function makeChat(): ChatMessage[] {
  return [
    { id: 'm1', role: 'user', content: 'Let me grab the EMP rifle.', summary: 'pick up rifle', intent: 'acquire_item' },
    { id: 'm2', role: 'model', content: 'You take the EMP rifle from the rack.', summary: 'pick up rifle resolved', thought: 'Player wants EMP rifle. Apply trigger.', inventory_log: ['acquired: EMP rifle x1'], character_log: ['mood: confident'] },
    { id: 'm3', role: 'user', content: 'Shoot the drone.', isHidden: true },
    { id: 'm4', role: 'model', content: 'The drone falls. You hear footsteps approaching.', world_log: ['drone destroyed at warehouse'] },
    { id: 'm5', role: 'user', content: 'Search the body.' },
    { id: 'm6', role: 'model', content: 'You find a keycard labeled "Sector 7".', inventory_log: ['acquired: keycard (Sector 7)'], quest_log: ['unlocked: Sector 7 access'] }
  ];
}

describe('listChatMessages', () => {
  it('errors when chatMessages is missing', () => {
    const { context } = makeContext({});
    const r = run({ action: 'listChatMessages', args: { reason: 'check' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/No chat history available/) });
  });

  it('errors when chatMessages is empty', () => {
    const { context } = makeContext({}, []);
    const r = run({ action: 'listChatMessages', args: { reason: 'check' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/No chat history available/) });
  });

  it('returns outline without content, excluding hidden by default', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'listChatMessages', args: { reason: 'check' } }, context);
    const messages = (r.response as { messages: { id: string; charCount: number; hasLogs: boolean; summary?: string }[] }).messages;
    expect(messages.map(m => m.id)).toEqual(['m1', 'm2', 'm4', 'm5', 'm6']);
    expect(messages[0]).not.toHaveProperty('content');
    expect(messages[0].charCount).toBe('Let me grab the EMP rifle.'.length);
    expect(messages[1].hasLogs).toBe(true);
    expect(messages[3].hasLogs).toBe(false);
    expect(messages[0].summary).toBe('pick up rifle');
  });

  it('includes hidden when flagged', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'listChatMessages', args: { reason: 'check', includeHidden: true } }, context);
    const ids = (r.response as { messages: { id: string }[] }).messages.map(m => m.id);
    expect(ids).toContain('m3');
  });

  it('respects limit (returns newest N)', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'listChatMessages', args: { reason: 'check', limit: 2 } }, context);
    const resp = r.response as { messages: { id: string }[]; olderRemaining: number };
    expect(resp.messages.map(m => m.id)).toEqual(['m5', 'm6']);
    expect(resp.olderRemaining).toBe(3); // m1, m2, m4 still visible-and-older
  });

  it('paginates with before (exclusive cutoff)', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'listChatMessages', args: { reason: 'check', before: 'm4', limit: 10 } }, context);
    const ids = (r.response as { messages: { id: string }[] }).messages.map(m => m.id);
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('errors when before id is not found', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'listChatMessages', args: { reason: 'check', before: 'nope' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/not found/) });
  });

  it('excludes intent=save turns by default', () => {
    const chat = [
      ...makeChat(),
      { id: 'save1', role: 'model', content: '<save>...</save>', intent: 'save' }
    ] as ChatMessage[];
    const { context } = makeContext({}, chat);
    const r = run({ action: 'listChatMessages', args: { reason: 'check' } }, context);
    const resp = r.response as { messages: { id: string }[]; filtered: { save: number } };
    expect(resp.messages.map(m => m.id)).not.toContain('save1');
    expect(resp.filtered.save).toBe(1);
  });

  it('includes save when includeSaves=true', () => {
    const chat = [
      ...makeChat(),
      { id: 'save1', role: 'model', content: '<save>...</save>', intent: 'save' }
    ] as ChatMessage[];
    const { context } = makeContext({}, chat);
    const r = run({ action: 'listChatMessages', args: { reason: 'check', includeSaves: true } }, context);
    const ids = (r.response as { messages: { id: string }[] }).messages.map(m => m.id);
    expect(ids).toContain('save1');
  });
});

describe('searchChatMessages', () => {
  it('errors when chatMessages is missing', () => {
    const { context } = makeContext({});
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: 'foo' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/No chat history available/) });
  });

  it('errors on empty pattern', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: '' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/pattern is required/) });
  });

  it('errors on invalid regex', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: '(' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/Invalid regex/) });
  });

  it('searches content by default and skips hidden', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: 'EMP' } }, context);
    const resp = r.response as { hits: { messageId: string; scope: string }[]; count: number };
    expect(resp.hits.map(h => h.messageId)).toEqual(['m1', 'm2']);
    expect(resp.hits.every(h => h.scope === 'content')).toBe(true);
  });

  it('honors scope=thought', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: 'trigger', scope: 'thought', caseInsensitive: true } }, context);
    const hits = (r.response as { hits: { messageId: string; scope: string }[] }).hits;
    expect(hits).toEqual([{ messageId: 'm2', url: 'app://message/m2', role: 'model', scope: 'thought', snippet: expect.any(String), matchIndex: expect.any(Number) }]);
  });

  it('scope=all searches across content / thought / summary', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: 'rifle', scope: 'all' } }, context);
    const hits = (r.response as { hits: { scope: string }[] }).hits;
    const scopes = new Set(hits.map(h => h.scope));
    expect(scopes.has('content')).toBe(true);
    expect(scopes.has('summary')).toBe(true);
  });

  it('snippet respects contextChars', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: 'rifle', contextChars: 5 } }, context);
    const snippet = (r.response as { hits: { snippet: string }[] }).hits[0].snippet;
    expect(snippet.length).toBeLessThan('Let me grab the EMP rifle.'.length + 5);
  });

  it('skips save-intent turns by default and reports suppressedSaves', () => {
    const chat = [
      ...makeChat(),
      { id: 'save1', role: 'model', content: 'EMP rifle EMP rifle EMP rifle', intent: 'save' }
    ] as ChatMessage[];
    const { context } = makeContext({}, chat);
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: 'EMP' } }, context);
    const resp = r.response as { hits: { messageId: string }[]; suppressedSaves?: number; note?: string };
    expect(resp.hits.map(h => h.messageId)).not.toContain('save1');
    expect(resp.suppressedSaves).toBe(1);
    expect(resp.note).toMatch(/save-intent/);
  });

  it('includes save-intent turns when includeSaves=true', () => {
    const chat = [
      ...makeChat(),
      { id: 'save1', role: 'model', content: 'EMP rifle here', intent: 'save' }
    ] as ChatMessage[];
    const { context } = makeContext({}, chat);
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: 'EMP', includeSaves: true } }, context);
    const ids = (r.response as { hits: { messageId: string }[] }).hits.map(h => h.messageId);
    expect(ids).toContain('save1');
  });

  it('caps hits at 3 per message and marks the last one with moreInSameMessage', () => {
    const dense: ChatMessage[] = [
      { id: 'd1', role: 'model', content: 'foo bar foo bar foo bar foo bar foo bar' }
    ];
    const { context } = makeContext({}, dense);
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: 'foo' } }, context);
    const hits = (r.response as { hits: { messageId: string; moreInSameMessage?: number }[] }).hits;
    expect(hits).toHaveLength(3);
    expect(hits[0].moreInSameMessage).toBeUndefined();
    expect(hits[1].moreInSameMessage).toBeUndefined();
    expect(hits[2].moreInSameMessage).toBe(2);
  });

  it('does NOT flag truncated when hits fill exactly to limit on the last available match', () => {
    // limit=2, two messages, one hit each → exactly fills; no further match
    // exists, so truncated must stay false (the algorithm only flips when
    // there is a real unshown hit). Pins Gemini's truncated-semantic concern.
    const chat: ChatMessage[] = [
      { id: 'a', role: 'user', content: 'apple' },
      { id: 'b', role: 'model', content: 'apple' }
    ];
    const { context } = makeContext({}, chat);
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: 'apple', limit: 2 } }, context);
    const resp = r.response as { hits: unknown[]; truncated: boolean; note?: string };
    expect(resp.hits).toHaveLength(2);
    expect(resp.truncated).toBe(false);
    expect(resp.note).toBeUndefined();
  });

  it('flags truncated with a guidance note when a further match exists past limit', () => {
    const chat: ChatMessage[] = [
      { id: 'a', role: 'user', content: 'apple' },
      { id: 'b', role: 'model', content: 'apple' },
      { id: 'c', role: 'user', content: 'apple' }
    ];
    const { context } = makeContext({}, chat);
    const r = run({ action: 'searchChatMessages', args: { reason: 'check', pattern: 'apple', limit: 2 } }, context);
    const resp = r.response as { hits: unknown[]; truncated: boolean; note?: string };
    expect(resp.hits).toHaveLength(2);
    expect(resp.truncated).toBe(true);
    expect(resp.note).toMatch(/limit=2/);
  });
});

describe('readChatMessage', () => {
  it('errors when chatMessages is missing', () => {
    const { context } = makeContext({});
    const r = run({ action: 'readChatMessage', args: { reason: 'check', messageIds: ['m1'] } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/No chat history available/) });
  });

  it('errors on empty messageIds', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'readChatMessage', args: { reason: 'check', messageIds: [] } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/messageIds must be a non-empty array/) });
  });

  it('returns only content by default', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'readChatMessage', args: { reason: 'check', messageIds: ['m2'] } }, context);
    const m = (r.response as { messages: Record<string, unknown>[] }).messages[0];
    expect(m['content']).toBe('You take the EMP rifle from the rack.');
    expect(m['thought']).toBeUndefined();
    expect(m['logs']).toBeUndefined();
    expect(m['summary']).toBeUndefined();
  });

  it('reports per-id error for missing ids without failing the call', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'readChatMessage', args: { reason: 'check', messageIds: ['m2', 'nope'] } }, context);
    const msgs = (r.response as { messages: { id: string; error?: string }[] }).messages;
    expect(msgs[0].id).toBe('m2');
    expect(msgs[0].error).toBeUndefined();
    expect(msgs[1]).toEqual({ id: 'nope', url: 'app://message/nope', error: 'Message not found' });
  });

  it('include=logs returns the structured per-kind logs block', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'readChatMessage', args: { reason: 'check', messageIds: ['m2', 'm6'], include: ['logs'] } }, context);
    const msgs = (r.response as { messages: { logs?: Record<string, string[]> }[] }).messages;
    expect(msgs[0].logs).toEqual({ inventory: ['acquired: EMP rifle x1'], character: ['mood: confident'] });
    expect(msgs[1].logs).toEqual({ inventory: ['acquired: keycard (Sector 7)'], quest: ['unlocked: Sector 7 access'] });
  });
});

describe('readTurnLogs', () => {
  it('errors when chatMessages is missing', () => {
    const { context } = makeContext({});
    const r = run({ action: 'readTurnLogs', args: { reason: 'check' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/No chat history available/) });
  });

  it('flattens all four log kinds across recent turns by default', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'readTurnLogs', args: { reason: 'check' } }, context);
    const groups = (r.response as { groups: { messageId: string; kind: string; entries: string[] }[] }).groups;
    const flat = groups.map(g => `${g.messageId}:${g.kind}`).sort();
    expect(flat).toEqual(['m2:character', 'm2:inventory', 'm4:world', 'm6:inventory', 'm6:quest']);
  });

  it('filters by kinds', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'readTurnLogs', args: { reason: 'check', kinds: ['inventory'] } }, context);
    const groups = (r.response as { groups: { kind: string }[] }).groups;
    expect(groups.every(g => g.kind === 'inventory')).toBe(true);
    expect(groups).toHaveLength(2);
  });

  it('filters by messageIds and errors on unknown id', () => {
    const { context } = makeContext({}, makeChat());
    const r1 = run({ action: 'readTurnLogs', args: { reason: 'check', messageIds: ['m6'] } }, context);
    const groups = (r1.response as { groups: { messageId: string }[] }).groups;
    expect(groups.every(g => g.messageId === 'm6')).toBe(true);

    const r2 = run({ action: 'readTurnLogs', args: { reason: 'check', messageIds: ['m6', 'nope'] } }, context);
    expect(r2.response).toMatchObject({ error: expect.stringMatching(/not found/) });
  });

  it('reports zero groups with a note when no recent turns have logs', () => {
    const noLogs: ChatMessage[] = [
      { id: 'a', role: 'user', content: 'hello' },
      { id: 'b', role: 'model', content: 'world' }
    ];
    const { context } = makeContext({}, noLogs);
    const r = run({ action: 'readTurnLogs', args: { reason: 'check' } }, context);
    expect(r.response).toMatchObject({ groups: [], count: 0, note: expect.stringMatching(/No log entries/) });
  });

  it('respects recent slice', () => {
    const { context } = makeContext({}, makeChat());
    const r = run({ action: 'readTurnLogs', args: { reason: 'check', recent: 1 } }, context);
    const groups = (r.response as { groups: { messageId: string }[] }).groups;
    expect(groups.every(g => g.messageId === 'm6')).toBe(true);
  });
});

describe('uiMap', () => {
  it('delegates to context.uiMap and returns its dump verbatim', () => {
    const callback = vi.fn(() => '- chat-input — Toolbar — Bottom toolbar\n  - send — Send — Send message');
    const { context } = makeContext({});
    context.uiMap = callback;

    const r = run({ action: 'uiMap', args: { reason: 'where' } }, context);

    expect(callback).toHaveBeenCalled();
    expect(r.response).toEqual({ map: '- chat-input — Toolbar — Bottom toolbar\n  - send — Send — Send message' });
  });

  it('returns an error when the context does not provide uiMap', () => {
    const { context } = makeContext({});
    const r = run({ action: 'uiMap', args: { reason: 'where' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringContaining('not available') });
  });
});

describe('chat tools include app://message/<id> url', () => {
  function makeChatWithIds(): ChatMessage[] {
    return [
      { id: 'm1', role: 'user', content: 'hello world', intent: 'action' } as ChatMessage,
      { id: 'm2', role: 'model', content: 'reply with world inside', summary: 'said hi' } as ChatMessage,
    ];
  }

  it('listChatMessages emits a url for every message', () => {
    const { context } = makeContext({}, makeChatWithIds());
    const r = run({ action: 'listChatMessages', args: { reason: 'r' } }, context);
    const messages = (r.response as { messages: { id: string; url: string }[] }).messages;
    expect(messages.every(m => m.url === `app://message/${m.id}`)).toBe(true);
  });

  it('searchChatMessages emits a url on each hit', () => {
    const { context } = makeContext({}, makeChatWithIds());
    const r = run({ action: 'searchChatMessages', args: { reason: 'r', pattern: 'world' } }, context);
    const hits = (r.response as { hits: { messageId: string; url: string }[] }).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.url === `app://message/${h.messageId}`)).toBe(true);
  });

  it('readChatMessage emits a url on each result (including not-found)', () => {
    const { context } = makeContext({}, makeChatWithIds());
    const r = run({ action: 'readChatMessage', args: { reason: 'r', messageIds: ['m1', 'missing'] } }, context);
    const msgs = (r.response as { messages: { id: string; url: string }[] }).messages;
    expect(msgs.find(m => m.id === 'm1')!.url).toBe('app://message/m1');
    expect(msgs.find(m => m.id === 'missing')!.url).toBe('app://message/missing');
  });
});
