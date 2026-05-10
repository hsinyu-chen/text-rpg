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
    slotHistory.set(id, []);
  }

  let touched = false;
  for (const { name, ast: layerAst } of layerAsts) {
    let layerEffective = false;
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

      const isReplaceOp = (k: OpKind) =>
        k === 'full-replace' || k === 'content-replace' || k === 'heading-replace';
      if (isReplaceOp(op.op)) {
        const prevReplace = [...history].reverse().find(h => isReplaceOp(h.op));
        if (prevReplace) {
          diagnostics.push({
            level: 'warning', file: op.source, line: op.startLine,
            message: `slot '${op.slotId}' replaced by both '${prevReplace.layer}' and '${name}'; '${name}' wins`,
          });
        }
      }

      finalSlots.set(op.slotId, applyOp(parent, op));
      history.push({ layer: name, op: op.op });
      slotHistory.set(op.slotId, history);
      layerEffective = true;
      touched = true;
    }
    if (!layerEffective && layerAst.ops.length === 0) {
      diagnostics.push({
        level: 'warning', file: layerAst.filePath,
        message: `layer file has no effective op`,
      });
    }
  }

  void touched;

  const manifest: ManifestSlotEntry[] = [];
  for (const [id, slot] of finalSlots) {
    const history = slotHistory.get(id) ?? [];
    const finalSource = history.length === 0
      ? slot.source
      : findLayerFilePath(layerAsts, history[history.length - 1].layer)
        ?? slot.source;
    manifest.push({ id, finalSource, layers: history });
  }

  return {
    finalAst: { ...baseAst, slots: finalSlots },
    manifest,
    diagnostics,
  };
}

function findLayerFilePath(
  layerAsts: ReadonlyArray<{ name: string; ast: LayerAst }>,
  name: string,
): string | undefined {
  return layerAsts.find(l => l.name === name)?.ast.filePath;
}

function applyOp(parent: SlotNode, op: LayerOp): SlotNode {
  if (op.op === 'remove') {
    return { ...parent, body: '', isRemove: true, source: op.source };
  }
  if (op.op === 'full-replace') {
    return { ...parent, body: op.body, isRemove: false, source: op.source };
  }
  const { heading, content } = splitHeading(parent.body);
  let newBody: string;
  switch (op.op) {
    case 'heading-replace':
      newBody = combine(op.body, content);
      break;
    case 'content-replace':
      newBody = combine(heading, op.body);
      break;
    case 'content-prepend':
      newBody = combine(heading, joinSegments([op.body, content]));
      break;
    case 'content-append':
      newBody = combine(heading, joinSegments([content, op.body]));
      break;
    default: {
      const _exhaustive: never = op.op;
      void _exhaustive;
      throw new Error(`unhandled op: ${op.op as string}`);
    }
  }
  return { ...parent, body: newBody, isRemove: false, source: op.source };
}

export function splitHeading(body: string): { heading: string; content: string } {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^\s*#+\s/.test(lines[i])) {
    return {
      heading: lines.slice(0, i + 1).join('\n'),
      content: lines.slice(i + 1).join('\n'),
    };
  }
  return { heading: '', content: body };
}

function combine(heading: string, content: string): string {
  if (!heading) return content;
  if (!content) return heading;
  return heading.replace(/\n+$/, '') + '\n' + content.replace(/^\n+/, '');
}

function joinSegments(parts: ReadonlyArray<string>): string {
  const cleaned = parts
    .map(p => p.replace(/^\n+/, '').replace(/\n+$/, ''))
    .filter(p => p.length > 0);
  return cleaned.join('\n');
}
