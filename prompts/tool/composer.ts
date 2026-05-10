import {
  Diagnostic, FileAst, LayerAst, LayerOp,
  ManifestSlotEntry, OpKind, SlotNode,
} from './types';

export interface ComposeResult {
  finalAst: FileAst;
  manifest: ManifestSlotEntry[];
  diagnostics: Diagnostic[];
}

export function compose(
  baseAst: FileAst,
  layerAsts: ReadonlyArray<{ name: string; ast: LayerAst }>,
): ComposeResult {
  const finalSlots = new Map<string, SlotNode>();
  const slotHistory = new Map<string, Array<{ layer: string; op: OpKind }>>();
  const diagnostics: Diagnostic[] = [];

  for (const [id, slot] of baseAst.slots) {
    finalSlots.set(id, { ...slot });
    // Seed history with base's own remove so layers can't silently revive it.
    slotHistory.set(id, slot.isRemove ? [{ layer: 'base', op: 'remove' }] : []);
  }

  for (const { name, ast: layerAst } of layerAsts) {
    if (layerAst.ops.length === 0) {
      diagnostics.push({
        level: 'warning', file: layerAst.filePath,
        message: `empty layer file (no ops)`,
      });
      continue;
    }
    for (const op of layerAst.ops) {
      const parent = finalSlots.get(op.slotId);
      if (!parent) {
        diagnostics.push({
          level: 'warning', file: op.source, line: op.startLine,
          message: `slot not found in base: '${op.slotId}'`,
        });
        continue;
      }
      const history = slotHistory.get(op.slotId) ?? [];
      const wasRemoved = history.some(h => h.op === 'remove');
      if (wasRemoved) {
        diagnostics.push({
          level: 'error', file: op.source, line: op.startLine,
          message: `slot '${op.slotId}' was removed by an earlier layer; subsequent op '${op.op}' is invalid`,
        });
        continue;
      }

      // A new op conflicts with a prior op iff their write-sets overlap.
      // - full-replace overwrites everything → conflicts with anything prior
      // - content-replace overwrites prior content-* (replace/prepend/append) silently → warn
      // - heading-replace conflicts only with another heading-replace (orthogonal to content-*)
      const writesContent = (k: OpKind): boolean =>
        k === 'content-replace' || k === 'content-prepend' || k === 'content-append' || k === 'full-replace';
      const writesHeading = (k: OpKind): boolean =>
        k === 'heading-replace' || k === 'full-replace';
      const conflictsWith = (prior: OpKind, next: OpKind): boolean => {
        if (next === 'full-replace' || next === 'remove') return true;
        if (next === 'content-replace') return writesContent(prior);
        if (next === 'heading-replace') return writesHeading(prior);
        return false;
      };
      const prevConflict = [...history].reverse().find(h => conflictsWith(h.op, op.op));
      if (prevConflict) {
        diagnostics.push({
          level: 'warning', file: op.source, line: op.startLine,
          message: `slot '${op.slotId}' replaced by both '${prevConflict.layer}' (${prevConflict.op}) and '${name}' (${op.op}); '${name}' wins`,
        });
      }

      finalSlots.set(op.slotId, applyOp(parent, op));
      history.push({ layer: name, op: op.op });
      slotHistory.set(op.slotId, history);
    }
  }

  const manifest: ManifestSlotEntry[] = [];
  for (const [id, slot] of finalSlots) {
    const history = slotHistory.get(id) ?? [];
    manifest.push({ id, finalSource: slot.source, layers: history });
  }

  return {
    finalAst: { ...baseAst, slots: finalSlots },
    manifest,
    diagnostics,
  };
}

function applyOp(parent: SlotNode, op: LayerOp): SlotNode {
  if (op.op === 'remove') {
    return { ...parent, body: '', isRemove: true, source: op.source };
  }
  if (op.op === 'full-replace') {
    return { ...parent, body: op.body, isRemove: false, source: op.source };
  }
  // Slots opened inside a fence carry code, not markdown — heading auto-detect
  // would mistake bash/python `# ...` comments for headings.
  const { heading, separator, content } = parent.insideFence
    ? { heading: '', separator: '', content: parent.body }
    : splitHeading(parent.body);
  let newBody: string;
  switch (op.op) {
    case 'heading-replace':
      newBody = combine(op.body, separator, content);
      break;
    case 'content-replace':
      newBody = combine(heading, separator, op.body);
      break;
    case 'content-prepend':
      newBody = combine(heading, separator, joinPreserveParagraphs(op.body, content));
      break;
    case 'content-append':
      newBody = combine(heading, separator, joinPreserveParagraphs(content, op.body));
      break;
    default: {
      const _exhaustive: never = op.op;
      void _exhaustive;
      throw new Error(`unhandled op: ${op.op as string}`);
    }
  }
  return { ...parent, body: newBody, isRemove: false, source: op.source };
}

export function splitHeading(body: string): {
  heading: string; separator: string; content: string;
} {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^\s*#+\s/.test(lines[i])) {
    // Heading prefix includes any leading blank lines so they survive
    // heading-replace / content-replace ops (was lost otherwise).
    const heading = lines.slice(0, i + 1).join('\n');
    let j = i + 1;
    let blanks = 0;
    while (j < lines.length && lines[j].trim() === '') {
      blanks++;
      j++;
    }
    const separator = blanks > 0 ? '\n\n' : (j < lines.length ? '\n' : '');
    const content = lines.slice(j).join('\n');
    return { heading, separator, content };
  }
  return { heading: '', separator: '', content: body };
}

function combine(heading: string, separator: string, content: string): string {
  if (!heading) return content;
  if (!content) return heading;
  // Default to a single newline when base had no heading (separator='') so a
  // freshly-injected heading doesn't squash onto the first line of content.
  const sep = separator || '\n';
  return heading.replace(/\n+$/, '') + sep + content.replace(/^\n+/, '');
}

/**
 * Concat two slot fragments, normalizing only the SEAM newlines.
 * Internal \n+ runs (e.g., intentional blank lines inside a code block) are
 * preserved — only the boundary between a and b is collapsed.
 */
function joinPreserveParagraphs(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const trailA = a.match(/\n+$/)?.[0]?.length ?? 0;
  const leadB = b.match(/^\n+/)?.[0]?.length ?? 0;
  const totalSeam = trailA + leadB;
  const sep = totalSeam >= 2 ? '\n\n' : '\n';
  return a.replace(/\n+$/, '') + sep + b.replace(/^\n+/, '');
}
