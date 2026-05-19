import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import {
  AstBlock, Diagnostic, FileAst, LayerAst, LayerOp,
  OP_KINDS, OpKind, SlotNode, SourceMap,
} from './types';

/** Read a file as UTF-8 with CRLF normalized to LF. */
export function readUtf8Lf(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

const SLOT_OPEN_RE = /^\s*<!--@slot:([a-z][a-z0-9-]*)(?:\s+([^>]*?))?\s*-->\s*$/;
const SLOT_END_RE = /^\s*<!--@end-->\s*$/;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

interface InternalSlot {
  id: string;
  body: string;
  isRemove: boolean;
  insideFence: boolean;
  parsedOp?: OpKind;
  startLine: number;
  source: string;
}

interface InternalAst {
  filePath: string;
  slots: Map<string, InternalSlot>;
  blocks: AstBlock[];
}

export function readSource(path: string): { lines: string[]; raw: string } {
  const raw = readUtf8Lf(path);
  const stripped = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  return { lines: stripped.split('\n'), raw };
}

export function parseBaseFile(filePath: string): { ast: FileAst; diagnostics: Diagnostic[] } {
  const raw = readUtf8Lf(filePath);
  return parseBaseFileFromString(filePath, raw);
}

export function parseBaseFileFromString(
  filePath: string,
  content: string,
  sourceMap?: SourceMap,
  baseDir?: string,
): { ast: FileAst; diagnostics: Diagnostic[] } {
  const stripped = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = stripped.split('\n');
  const { ast: internal, diagnostics } = parseLines(filePath, lines);
  const slots = new Map<string, SlotNode>();
  for (const [id, s] of internal.slots) {
    const { line: originalLine, source: originalSource } =
      mapStart(s.startLine, filePath, sourceMap);
    slots.set(id, {
      id: s.id, body: s.body, isRemove: s.isRemove,
      insideFence: s.insideFence,
      startLine: originalLine,
      source: originalSource ?? s.source,
    });
  }
  const remapped = sourceMap
    ? diagnostics.map(d => remapDiagnostic(d, filePath, sourceMap, baseDir))
    : diagnostics;
  return {
    ast: { filePath, slots, blocks: internal.blocks },
    diagnostics: remapped,
  };
}

export function parseLayerFile(filePath: string): { ast: LayerAst; diagnostics: Diagnostic[] } {
  const raw = readUtf8Lf(filePath);
  return parseLayerFileFromString(filePath, raw);
}

export function parseLayerFileFromString(
  filePath: string,
  content: string,
  sourceMap?: SourceMap,
  baseDir?: string,
): { ast: LayerAst; diagnostics: Diagnostic[] } {
  const stripped = content.endsWith('\n') ? content.slice(0, -1) : content;
  const lines = stripped.split('\n');
  const { ast: internal, diagnostics } = parseLines(filePath, lines);

  // Layer files: invariant content outside slots is ignored, but warn if non-whitespace.
  for (const block of internal.blocks) {
    if (block.kind === 'invariant') {
      const stray = block.lines.find(l => l.trim() !== '');
      if (stray) {
        diagnostics.push({
          level: 'warning',
          file: filePath,
          message: `layer file has invariant content outside slots (ignored): "${stray.slice(0, 60)}"`,
        });
        break;
      }
    }
  }

  const ops: LayerOp[] = [];
  for (const [, slot] of internal.slots) {
    const op: OpKind = slot.parsedOp ?? 'content-replace';
    const { line: originalLine, source: originalSource } =
      mapStart(slot.startLine, filePath, sourceMap);
    ops.push({
      slotId: slot.id,
      op,
      body: slot.body,
      source: originalSource ?? filePath,
      startLine: originalLine,
    });
  }
  const remapped = sourceMap
    ? diagnostics.map(d => remapDiagnostic(d, filePath, sourceMap, baseDir))
    : diagnostics;
  return { ast: { filePath, ops }, diagnostics: remapped };
}

function mapStart(
  processedLine: number,
  hostFile: string,
  sourceMap?: SourceMap,
): { line: number; source?: string } {
  if (!sourceMap || processedLine < 1 || processedLine > sourceMap.lines.length) {
    return { line: processedLine };
  }
  const entry = sourceMap.lines[processedLine - 1];
  if (entry.file === hostFile) return { line: entry.line };
  // Slot originating inside a partial — keep host as the "owner" for layer
  // resolution but reflect the partial as the source for manifest purposes.
  return { line: entry.line, source: entry.file };
}

function remapDiagnostic(
  d: Diagnostic,
  hostFile: string,
  sourceMap: SourceMap,
  baseDir?: string,
): Diagnostic {
  if (d.line === undefined) return d;
  if (d.line < 1 || d.line > sourceMap.lines.length) return d;
  const entry = sourceMap.lines[d.line - 1];

  // Embedded "(also at line N)" / "(open at line N ...)" references must also
  // be remapped — they were emitted in processed-line space.
  const remappedMessage = d.message.replace(/\bline (\d+)\b/g, (whole, num: string) => {
    const n = Number(num);
    if (!Number.isFinite(n) || n < 1 || n > sourceMap.lines.length) return whole;
    const e = sourceMap.lines[n - 1];
    if (e.file === hostFile) return `line ${e.line}`;
    const viaRel = baseDir
      ? relative(baseDir, e.file).replace(/\\/g, '/')
      : e.file;
    return `line ${e.line} of ${viaRel}`;
  });

  if (entry.file === hostFile) {
    return { ...d, line: entry.line, message: remappedMessage };
  }
  const viaRel = baseDir
    ? relative(baseDir, entry.file).replace(/\\/g, '/')
    : entry.file;
  // Keep host reference baseDir-relative so the diagnostic stays portable
  // across machines (pipeline.ts only normalizes the `file` field).
  const hostRel = baseDir
    ? relative(baseDir, hostFile).replace(/\\/g, '/')
    : hostFile;
  return {
    ...d,
    line: entry.line,
    file: entry.file,
    message: `${remappedMessage} (via ${viaRel}, host ${hostRel})`,
  };
}

function parseLines(filePath: string, lines: string[]): { ast: InternalAst; diagnostics: Diagnostic[] } {
  const slots = new Map<string, InternalSlot>();
  const blocks: AstBlock[] = [];
  const diagnostics: Diagnostic[] = [];

  let invariantBuf: string[] = [];
  let inSlot:
    | {
        id: string;
        startLine: number;
        bodyLines: string[];
        fenceDepthAtOpen: number;
        parsedOp?: OpKind;
      }
    | null = null;
  let fenceDepth = 0;
  let fenceMarker = '';
  let fenceOpenLength = 0;

  const flushInvariant = () => {
    blocks.push({ kind: 'invariant', lines: invariantBuf });
    invariantBuf = [];
  };

  const trackFence = (line: string) => {
    const m = line.match(FENCE_RE);
    if (!m) return;
    const marker = m[2][0];
    const length = m[2].length;
    if (fenceDepth === 0) {
      fenceDepth = 1;
      fenceMarker = marker;
      fenceOpenLength = length;
    } else if (marker === fenceMarker && length >= fenceOpenLength) {
      fenceDepth = 0;
      fenceMarker = '';
      fenceOpenLength = 0;
    }
  };

  const recordSlot = (slot: InternalSlot, line: number) => {
    const existing = slots.get(slot.id);
    if (existing) {
      diagnostics.push({
        level: 'error', file: filePath, line,
        message: `duplicate slot id '${slot.id}' (also at line ${existing.startLine})`,
      });
      return;
    }
    slots.set(slot.id, slot);
    blocks.push({ kind: 'slot-ref', slotId: slot.id });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const slotOpen = line.match(SLOT_OPEN_RE);
    const slotEnd = line.match(SLOT_END_RE);

    // Unknown-anchor diagnostic only fires outside slots and outside fences:
    // anchor-shaped strings inside slot bodies or code fences are content.
    if (!inSlot && fenceDepth === 0 && !slotOpen && !slotEnd && looksLikeUnknownAnchor(line)) {
      diagnostics.push({
        level: 'error', file: filePath, line: lineNum,
        message: `unknown anchor: ${line.trim()}`,
      });
    }

    if (inSlot) {
      if (slotEnd) {
        if (fenceDepth !== inSlot.fenceDepthAtOpen) {
          diagnostics.push({
            level: 'error', file: filePath, line: lineNum,
            message: `slot '${inSlot.id}' crosses fence boundary (open at line ${inSlot.startLine} fence-depth ${inSlot.fenceDepthAtOpen}, close fence-depth ${fenceDepth})`,
          });
          inSlot = null;
          continue;
        }
        recordSlot(
          {
            id: inSlot.id,
            body: inSlot.bodyLines.join('\n'),
            isRemove: false,
            insideFence: inSlot.fenceDepthAtOpen > 0,
            parsedOp: inSlot.parsedOp,
            startLine: inSlot.startLine,
            source: filePath,
          },
          lineNum,
        );
        inSlot = null;
        continue;
      }
      if (slotOpen) {
        diagnostics.push({
          level: 'error', file: filePath, line: lineNum,
          message: `nested slot '${slotOpen[1]}' inside '${inSlot.id}' (v1 unsupported)`,
        });
        continue;
      }
      trackFence(line);
      inSlot.bodyLines.push(line);
      continue;
    }

    if (slotOpen) {
      const id = slotOpen[1];
      const attrs = parseAttrs(slotOpen[2] || '', filePath, lineNum, diagnostics);
      flushInvariant();
      if (attrs.isRemove) {
        recordSlot(
          {
            id, body: '', isRemove: true, insideFence: fenceDepth > 0,
            parsedOp: 'remove',
            startLine: lineNum, source: filePath,
          },
          lineNum,
        );
        continue;
      }
      inSlot = {
        id, startLine: lineNum, bodyLines: [],
        fenceDepthAtOpen: fenceDepth, parsedOp: attrs.op,
      };
      continue;
    }

    if (slotEnd) {
      diagnostics.push({
        level: 'error', file: filePath, line: lineNum,
        message: `unmatched <!--@end--> (no open slot)`,
      });
      continue;
    }

    trackFence(line);
    invariantBuf.push(line);
  }

  if (inSlot) {
    diagnostics.push({
      level: 'error', file: filePath, line: inSlot.startLine,
      message: `slot '${inSlot.id}' opened but never closed`,
    });
  }
  flushInvariant();

  return {
    ast: { filePath, slots, blocks },
    diagnostics,
  };
}

function looksLikeUnknownAnchor(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('<!--@')) return false;
  if (!trimmed.endsWith('-->')) return false;
  if (SLOT_OPEN_RE.test(line) || SLOT_END_RE.test(line)) return false;
  return true;
}

function parseAttrs(
  raw: string, file: string, line: number, diagnostics: Diagnostic[],
): { op?: OpKind; isRemove: boolean } {
  const result: { op?: OpKind; isRemove: boolean } = { isRemove: false };
  if (!raw.trim()) return result;
  const tokens = tokenizeAttrs(raw);
  for (const t of tokens) {
    if (t === 'remove') {
      result.isRemove = true;
      continue;
    }
    const m = t.match(/^op="(.+)"$/);
    if (m) {
      const v = m[1];
      if (!OP_KINDS.includes(v as OpKind)) {
        diagnostics.push({
          level: 'error', file, line,
          message: `unknown op value: '${v}' (valid: ${OP_KINDS.join(', ')})`,
        });
        continue;
      }
      result.op = v as OpKind;
      if (v === 'remove') result.isRemove = true;
      continue;
    }
    diagnostics.push({
      level: 'error', file, line,
      message: `unrecognized slot attribute: '${t}'`,
    });
  }
  return result;
}

function tokenizeAttrs(s: string): string[] {
  const out: string[] = [];
  // Accept escaped backslash-anything inside quoted attribute values.
  const re = /\S+="(?:\\[\s\S]|[^"])*"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}
