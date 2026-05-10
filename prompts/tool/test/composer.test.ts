import { describe, expect, it } from 'vitest';

import { compose } from '../composer';
import { FileAst, LayerAst, OpKind, SlotNode } from '../types';

function baseAst(slots: Record<string, string>): FileAst {
  const map = new Map<string, SlotNode>();
  for (const [id, body] of Object.entries(slots)) {
    map.set(id, { id, body, isRemove: false, startLine: 1, source: 'base.md' });
  }
  return {
    filePath: 'base.md',
    slots: map,
    blocks: Object.keys(slots).map(id => ({ kind: 'slot-ref' as const, slotId: id })),
  };
}

function layer(name: string, ops: Array<{ id: string; op: OpKind; body: string }>): { name: string; ast: LayerAst } {
  return {
    name,
    ast: {
      filePath: `${name}.md`,
      ops: ops.map(o => ({
        slotId: o.id, op: o.op, body: o.body,
        source: `${name}.md`, startLine: 1,
      })),
    },
  };
}

describe('per-op happy path', () => {
  it('heading-replace keeps content, swaps heading', () => {
    const base = baseAst({ s: '## Old Title\nline1\nline2' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'heading-replace', body: '## New Title' }])]);
    expect(r.diagnostics).toEqual([]);
    expect(r.finalAst.slots.get('s')!.body).toBe('## New Title\nline1\nline2');
  });

  it('content-replace keeps heading, swaps content', () => {
    const base = baseAst({ s: '## Title\nold' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'content-replace', body: 'new' }])]);
    expect(r.finalAst.slots.get('s')!.body).toBe('## Title\nnew');
  });

  it('content-prepend prepends to content', () => {
    const base = baseAst({ s: '## Title\nbody' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'content-prepend', body: 'pre' }])]);
    expect(r.finalAst.slots.get('s')!.body).toBe('## Title\npre\nbody');
  });

  it('content-append appends to content', () => {
    const base = baseAst({ s: '## Title\nbody' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'content-append', body: 'post' }])]);
    expect(r.finalAst.slots.get('s')!.body).toBe('## Title\nbody\npost');
  });

  it('full-replace replaces entire body', () => {
    const base = baseAst({ s: '## Title\nbody' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'full-replace', body: '# New\ntext' }])]);
    expect(r.finalAst.slots.get('s')!.body).toBe('# New\ntext');
  });

  it('remove marks slot.isRemove=true', () => {
    const base = baseAst({ s: '## Title\nbody' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'remove', body: '' }])]);
    expect(r.finalAst.slots.get('s')!.isRemove).toBe(true);
  });
});

describe('multi-layer composition', () => {
  it('two replaces on same slot — later wins, warns', () => {
    const base = baseAst({ s: '## T\nold' });
    const r = compose(base, [
      layer('A', [{ id: 's', op: 'content-replace', body: 'a' }]),
      layer('B', [{ id: 's', op: 'content-replace', body: 'b' }]),
    ]);
    expect(r.finalAst.slots.get('s')!.body).toBe('## T\nb');
    expect(r.diagnostics.some(d => d.level === 'warning' && /'A'.+'B'/.test(d.message))).toBe(true);
  });

  it('heading-replace + content-replace are orthogonal — both apply, no warning', () => {
    const base = baseAst({ s: '## Old\nbody' });
    const r = compose(base, [
      layer('A', [{ id: 's', op: 'heading-replace', body: '## New' }]),
      layer('B', [{ id: 's', op: 'content-replace', body: 'new body' }]),
    ]);
    expect(r.finalAst.slots.get('s')!.body).toBe('## New\nnew body');
    expect(r.diagnostics.filter(d => d.level === 'warning')).toEqual([]);
  });

  it('replace then prepend — order semantics, no warning', () => {
    const base = baseAst({ s: '## T\nold' });
    const r = compose(base, [
      layer('A', [{ id: 's', op: 'content-replace', body: 'mid' }]),
      layer('B', [{ id: 's', op: 'content-prepend', body: 'pre' }]),
    ]);
    expect(r.finalAst.slots.get('s')!.body).toBe('## T\npre\nmid');
    expect(r.diagnostics.filter(d => d.level === 'warning')).toEqual([]);
  });

  it('remove then any op — error', () => {
    const base = baseAst({ s: 'body' });
    const r = compose(base, [
      layer('A', [{ id: 's', op: 'remove', body: '' }]),
      layer('B', [{ id: 's', op: 'content-replace', body: 'x' }]),
    ]);
    expect(r.diagnostics.some(d => d.level === 'error' && d.message.includes('removed'))).toBe(true);
  });

  it('content-prepend then content-replace — warn (replace squashes the addition)', () => {
    const base = baseAst({ s: 'old' });
    const r = compose(base, [
      layer('A', [{ id: 's', op: 'content-prepend', body: 'extra' }]),
      layer('B', [{ id: 's', op: 'content-replace', body: 'new' }]),
    ]);
    expect(r.diagnostics.some(d => d.level === 'warning' && /'A'.+'B'/.test(d.message))).toBe(true);
  });
});

describe('base-level remove', () => {
  it('base slot with isRemove=true cannot be silently revived by a layer op', () => {
    const slots = new Map();
    slots.set('s', { id: 's', body: '', isRemove: true, startLine: 1, source: 'base.md' });
    const base: import('../types').FileAst = {
      filePath: 'base.md', slots,
      blocks: [{ kind: 'slot-ref', slotId: 's' }],
    };
    const r = compose(base, [layer('L', [{ id: 's', op: 'content-replace', body: 'x' }])]);
    expect(r.diagnostics.some(d => d.level === 'error' && d.message.includes('removed'))).toBe(true);
  });
});

describe('warnings', () => {
  it('layer references slot not in base — warning', () => {
    const base = baseAst({ s: 'body' });
    const r = compose(base, [layer('L', [{ id: 'missing', op: 'content-replace', body: 'x' }])]);
    expect(r.diagnostics.some(d => d.level === 'warning' && d.message.includes('not found in base'))).toBe(true);
  });

  it('layer with zero ops — warning (empty layer file)', () => {
    const base = baseAst({ s: 'body' });
    const r = compose(base, [layer('L', [])]);
    expect(r.diagnostics.some(d => d.level === 'warning' && d.message.includes('empty layer file'))).toBe(true);
  });
});

describe('heading + content blank-line preservation', () => {
  it('content-replace preserves blank line between heading and content if base had one', () => {
    const base = baseAst({ s: '## Title\n\nold' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'content-replace', body: 'new' }])]);
    expect(r.finalAst.slots.get('s')!.body).toBe('## Title\n\nnew');
  });

  it('content-replace keeps single-newline join when base had no blank line', () => {
    const base = baseAst({ s: '## Title\nold' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'content-replace', body: 'new' }])]);
    expect(r.finalAst.slots.get('s')!.body).toBe('## Title\nnew');
  });
});

describe('paragraph preservation', () => {
  it('content-prepend joins with single newline when neither side has trailing/leading newline', () => {
    const base = baseAst({ s: 'old' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'content-prepend', body: 'chunk' }])]);
    expect(r.finalAst.slots.get('s')!.body).toBe('chunk\nold');
  });

  it('content-prepend preserves paragraph break when chunk ends with two newlines', () => {
    const base = baseAst({ s: 'para A\n\npara B' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'content-prepend', body: 'para X\n\n' }])]);
    expect(r.finalAst.slots.get('s')!.body).toBe('para X\n\npara A\n\npara B');
  });

  it('content-append preserves paragraph break when chunk starts with two newlines', () => {
    const base = baseAst({ s: 'para A\n\npara B' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'content-append', body: '\n\npara X' }])]);
    expect(r.finalAst.slots.get('s')!.body).toBe('para A\n\npara B\n\npara X');
  });

  it('collapses excessive blank runs (3+) to paragraph separator (2)', () => {
    const base = baseAst({ s: 'old' });
    const r = compose(base, [layer('L', [{ id: 's', op: 'content-prepend', body: 'chunk\n\n\n\n' }])]);
    expect(r.finalAst.slots.get('s')!.body).toBe('chunk\n\nold');
  });
});
