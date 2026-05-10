import { FileAst } from './types';

export function render(ast: FileAst): string {
  const segs: string[] = [];
  for (const block of ast.blocks) {
    if (block.kind === 'invariant') {
      if (block.lines.length === 0) continue;
      segs.push(block.lines.join('\n'));
      continue;
    }
    const slot = ast.slots.get(block.slotId);
    if (!slot || slot.isRemove) continue;
    if (slot.body !== '') segs.push(slot.body);
  }
  return segs.join('\n') + '\n';
}
