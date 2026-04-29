import { describe, expect, it, vi } from 'vitest';
import { executeFileTool } from './file-agent-tool-executor';
import type { FileAgentContext, ParsedAction } from './file-agent.types';

function makeContext(files: Record<string, string>): {
  context: FileAgentContext;
  onFileReplaced: ReturnType<typeof vi.fn>;
} {
  const map = new Map<string, string>(Object.entries(files));
  const onFileReplaced = vi.fn((filename: string, content: string) => {
    map.set(filename, content);
  });
  return { context: { files: map, onFileReplaced }, onFileReplaced };
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
    const r = run({ action: 'readSection', args: { filename: 'a.md', sectionPaths: ['Missing', 'Same'] } }, context) as { response: { sections: { path: string; error?: string }[] } };
    expect(r.response.sections[0]).toMatchObject({ path: 'Missing', error: 'Section not found' });
    expect(r.response.sections[1]).toMatchObject({ path: 'Same', error: expect.stringMatching(/Ambiguous/) });
  });

  it('returns body without the heading line and uses 1-indexed line numbers', () => {
    const md = ['# A', 'a-body-1', 'a-body-2', '# B'].join('\n');
    const { context } = makeContext({ 'a.md': md });
    const r = run({ action: 'readSection', args: { filename: 'a.md', sectionPaths: ['A'] } }, context) as { response: { sections: { content: string; startLine: number; endLine: number }[] } };
    expect(r.response.sections[0]).toMatchObject({ content: 'a-body-1\na-body-2', startLine: 1, endLine: 3 });
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
    run({ action: 'replaceSection', args: { filename: 'a.md', updates: [{ sectionPath: 'A', content: 'new' }] } }, context);
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\nnew\n# B\nb');
  });

  it('renames the heading when newTitle is provided', () => {
    const md = ['## Old', 'body'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    run({ action: 'replaceSection', args: { filename: 'a.md', updates: [{ sectionPath: 'Old', content: 'body', newTitle: 'New' }] } }, context);
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '## New\nbody');
  });

  it('clears body when content is empty string', () => {
    const md = ['# A', 'old', '# B'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    run({ action: 'replaceSection', args: { filename: 'a.md', updates: [{ sectionPath: 'A', content: '' }] } }, context);
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\n# B');
  });

  it('applies multiple updates bottom-up so earlier indices stay valid', () => {
    const md = ['# A', 'a', '# B', 'b', '# C', 'c'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    run({ action: 'replaceSection', args: { filename: 'a.md', updates: [
      { sectionPath: 'A', content: 'A-new line one\nA-new line two' },
      { sectionPath: 'C', content: 'C-new' },
    ] } }, context);
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
    run({ action: 'replaceSection', args: { filename: 'a.md', updates: [{ sectionPath: 'A', content: 'flattened', force: true }] } }, context);
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\nflattened\n# B');
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
    run({ action: 'insertSection', args: { filename: 'a.md', heading: '# Mid', content: 'm', anchor: 'before', anchorSectionPath: 'B' } }, context);
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\na\n# Mid\nm\n\n# B');
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
    const r = run({ action: 'insertIntoSection', args: { filename: 'a.md', sectionPath: 'A', content: 'x', position: 'middle' as 'start' } }, context);
    expect(r.response).toMatchObject({ error: expect.stringMatching(/position must be/) });
  });

  it('inserts right after the heading line when position=start', () => {
    const md = ['# A', 'existing', '# B'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    run({ action: 'insertIntoSection', args: { filename: 'a.md', sectionPath: 'A', content: 'new-first', position: 'start' } }, context);
    expect(onFileReplaced).toHaveBeenCalledWith('a.md', '# A\nnew-first\nexisting\n# B');
  });

  it('inserts after all body and child sections when position=end', () => {
    const md = ['# A', '## A1', 'aa-body', '# B'].join('\n');
    const { context, onFileReplaced } = makeContext({ 'a.md': md });
    run({ action: 'insertIntoSection', args: { filename: 'a.md', sectionPath: 'A', content: 'tail', position: 'end' } }, context);
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
