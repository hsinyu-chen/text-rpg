export type OpKind =
  | 'heading-replace'
  | 'content-replace'
  | 'content-prepend'
  | 'content-append'
  | 'full-replace'
  | 'remove';

export const OP_KINDS: ReadonlyArray<OpKind> = [
  'heading-replace',
  'content-replace',
  'content-prepend',
  'content-append',
  'full-replace',
  'remove',
] as const;

export interface SlotNode {
  id: string;
  body: string;
  isRemove: boolean;
  /** True if the slot opened while inside a markdown code fence — body is code,
   *  heading auto-detection should be skipped. */
  insideFence: boolean;
  startLine: number;
  source: string;
}

export type AstBlock =
  | { kind: 'invariant'; lines: string[] }
  | { kind: 'slot-ref'; slotId: string };

export interface FileAst {
  filePath: string;
  slots: Map<string, SlotNode>;
  blocks: AstBlock[];
}

export interface LayerOp {
  slotId: string;
  op: OpKind;
  body: string;
  source: string;
  startLine: number;
}

export interface LayerAst {
  filePath: string;
  ops: LayerOp[];
}

export type DiagnosticLevel = 'warning' | 'error';

export interface Diagnostic {
  level: DiagnosticLevel;
  file: string;
  line?: number;
  message: string;
}

export interface VariantConfig {
  base_dirs: Record<string, string>;
  layer_dirs: Record<string, string>;
  variants: Record<string, { base: string; layers: string[] }>;
  output_paths: Record<string, string>;
  per_file: Record<string, { passthrough: boolean }>;
}

export interface ManifestSlotEntry {
  id: string;
  finalSource: string;
  layers: Array<{ layer: string; op: OpKind }>;
}

export interface ManifestEntry {
  variantKey: string;
  filePath: string;
  passthrough: boolean;
  slots?: ManifestSlotEntry[];
}

export interface Manifest {
  generatedAt: string;
  entries: ManifestEntry[];
}
