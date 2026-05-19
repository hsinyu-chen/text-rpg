/**
 * Shared types for the multi-agent save pipeline. Stage executors, data
 * providers, and the Debug UI all consume from here so a single type rename
 * propagates without import churn.
 *
 * Plan: TextRPG_Plans/doing/multi-agent-save-simulation.md
 */

/**
 * One condensed unit of "something happened in the ACT" extracted from a
 * single `role: 'model'` chat message. Stage B-1 (Visibility Tagger) sees a
 * list of these and emits per-entity visibility verdicts referencing them by
 * {@link SceneEvent.eventId}.
 *
 * `eventId` is the 8-char prefix of `messageId` — stable within a save run,
 * compact enough for LLM JSON output to reference without ballooning tokens.
 */
export interface SceneEvent {
  eventId: string;
  messageId: string;
  /**
   * The first-line bracket header from the model message content
   * (e.g. `[T 大宋 景德三年 三月初九 12:42]`). Empty string when the model
   * output had no bracket header on line 1.
   */
  sceneHeader: string;
  /** Model-side single-sentence summary of the turn. Empty when absent. */
  summary: string;
  character_log: string[];
  inventory_log: string[];
  quest_log: string[];
  world_log: string[];
}

/**
 * Names of the array-of-strings log fields carried on `SceneEvent` and
 * the source `ChatMessage`. `as const` so consumers (Debug UI template,
 * Stage B-1 prompt builders) can iterate with full type safety instead of
 * casting through `$any(event)[field]`.
 */
export const SCENE_EVENT_LOG_FIELDS = [
  'character_log',
  'inventory_log',
  'quest_log',
  'world_log',
] as const;
export type SceneEventLogField = typeof SCENE_EVENT_LOG_FIELDS[number];

/**
 * One NPC entry extracted from `3.人物狀態.md`. `headingPath` is the
 * breadcrumb (`# 核心人物 > ## 露娜`) — Stage B-3 emits this as the
 * `<save context="…">` attribute so the existing FileUpdateParser can locate
 * the entry on apply.
 *
 * Line bounds are 0-based and inclusive on both ends, matching
 * {@link import('@app/core/services/file-agent/markdown-section.util').SectionBounds}.
 */
export interface CharacterEntry {
  /** L2 heading text, e.g. `露娜 (Luna)`. */
  name: string;
  /** Breadcrumb like `# 核心人物 > ## 露娜 (Luna)`. */
  headingPath: string;
  /**
   * L1 ancestor heading text verbatim (e.g. `核心人物`, `已故人物`,
   * `Core Characters`, or anything else the author wrote). The provider
   * doesn't whitelist — downstream (LLM stages, Debug UI) decides what to
   * do with each group. Empty string is impossible: orphan L2s without an
   * L1 ancestor are dropped at extraction time.
   */
  group: string;
  startLine: number;
  endLine: number;
  /** Full entry text (heading line through last body line, no trailing blanks). */
  rawText: string;
}

/**
 * One faction (or other world-state entity) extracted from `6.勢力與世界.md`.
 * Structurally identical to {@link CharacterEntry} today — kept as a
 * separate interface so type-safety per concept survives if either side's
 * shape diverges (e.g. factions gain a `powerLevel`, characters gain
 * `coreValues`). Stage B treats both as simulation targets, so consumers
 * that bind to the union {@link CharacterEntry} | {@link FactionEntry}
 * will continue to compile.
 */
export interface FactionEntry {
  name: string;
  headingPath: string;
  /**
   * L1 ancestor heading text verbatim (e.g. `主要勢力`, `核心世界觀`,
   * `關鍵物品`). Like {@link CharacterEntry.group}, no whitelist —
   * downstream decides what to do with each group (LLM stages skip
   * `關鍵物品`-style entries as non-actors).
   */
  group: string;
  startLine: number;
  endLine: number;
  rawText: string;
}

// ============================================================================
// SaveAgent Manifest
// ============================================================================

/** Add/remove/update — one verb across inventory / assets / plans. */
export type DeltaOp = 'add' | 'remove' | 'update';

export interface InventoryDelta {
  op: DeltaOp;
  /** Item name (original wording). `remove` may use the bare name. */
  item: string;
  /**
   * New-state description appended after the item name on `add` / `update`.
   * When omitted the handler falls back to a bare `- item` line, which is a
   * valid (if terse) inventory entry. Strongly encouraged for `add` /
   * `update` so the entry is self-documenting; ignored on `remove`.
   */
  details?: string;
}

export interface PlanDelta {
  op: DeltaOp;
  title: string;
  /** Full entry body. Strongly encouraged for `add` / `update`; ignored on `remove`. */
  body?: string;
}

/** Free-form section update keyed by a breadcrumb path like `# X > ## Y`. */
export interface SectionUpdate {
  sectionPath: string;
  content: string;
}

export interface CharacterCreate {
  name: string;
  /** L1 group heading text verbatim. */
  group: string;
  /**
   * Initial entry fields (身分 / 基本設定 / 最後已知位置 / 初始目前心態 …)
   * keyed by the canonical field name. SaveAgent fills these — Phase 1 does
   * no LLM polish layer on top.
   */
  draftedFields: Record<string, string>;
}

export interface EntityDelete {
  name: string;
  reason: string;
}

export interface EntityMove {
  name: string;
  /** Target L1 group heading text. */
  toGroup: string;
  reason: string;
}

export interface EntityUpdate {
  name: string;
  /** Optional motivation hint — trace-only, does not influence sub-tool visibility filter. */
  reasonHint?: string;
}

export interface SkippedLog {
  logId: string;
  reason: string;
}

export interface CompletenessAudit {
  processedLogIds: string[];
  skippedLogIds: SkippedLog[];
}

/**
 * SaveAgent's top-level routing output. The dispatcher walks each field and
 * fires the matching sub-tool (mechanical handler or LLM chain).
 *
 * **Phase 1 status**: only `inventoryDeltas` has a wired handler. Other
 * fields parse + validate but the dispatcher marks them `not_yet_implemented`
 * in the progress trace.
 */
export interface SaveManifest {
  storyOutlineBlock?: string;
  inventoryDeltas?: InventoryDelta[];
  assetsDeltas?: InventoryDelta[];
  plansDeltas?: PlanDelta[];
  techEquipmentUpdates?: SectionUpdate[];
  magicSkillsUpdates?: SectionUpdate[];
  worldFeaturesUpdates?: SectionUpdate[];
  charactersToCreate?: CharacterCreate[];
  factionsToCreate?: CharacterCreate[];
  charactersToDelete?: EntityDelete[];
  factionsToDelete?: EntityDelete[];
  charactersToMove?: EntityMove[];
  factionsToMove?: EntityMove[];
  charactersToUpdate?: EntityUpdate[];
  factionsToUpdate?: EntityUpdate[];
  completenessAudit: CompletenessAudit;
}

/**
 * Mechanical sub-tool identifiers — one per dispatch branch the handler
 * registry implements. Used as the `toolName` field on progress events.
 */
// ============================================================================
// Progress events — emitted by every layer (SaveAgent / dispatcher / sub-tool)
// for the SaveProgressDialog to render per-entry cards.
// ============================================================================

export type SavePhase = 'manifest' | 'dispatch' | 'sub-tool' | 'finalize';
export type SaveEntryState = 'running' | 'retry' | 'done' | 'skipped' | 'failed';

/**
 * One immutable entry shown as a card in `SaveProgressDialog`. The tracker
 * starts an entry with `state: 'running'`, accumulates streaming chunks
 * (`thought`, `output`, `ppProgress`, `usage`), and resolves it to `done` /
 * `skipped` / `failed`.
 *
 * `entryId` is unique per session — generated at entry-start time, used by
 * the dialog template's `@for` track expression.
 */
export interface SaveProgressEntry {
    entryId: string;
    phase: SavePhase;
    state: SaveEntryState;
    /** Manifest field / mechanical tool name (e.g. `inventoryDeltas`). */
    toolName?: string;
    /** For LLM sub-tools: which entity is being updated. */
    entityName?: string;
    /** Streamed CoT — accumulated, shown in a collapsible details panel. */
    thought: string;
    /** Streamed structured output — JSON / XML, shown in a code block. */
    output: string;
    /** Prefill / prompt-processing progress (0-1 ratio reported by the provider). */
    ppProgress?: number;
    /** Token usage totals reported by the provider. */
    usage?: { prompt: number; candidates: number; cached: number };
    /** Set on `failed` / `skipped`; rendered as the entry's status reason. */
    statusReason?: string;
    /** Set on `failed` / `done` / `skipped`; ISO timestamp for trace export. */
    finishedAt?: string;
    /** ISO timestamp set at entry creation. */
    startedAt: string;
}

/** Reason codes for `state: 'skipped'`. */
export type SaveSkipReason =
    | 'not_yet_implemented'
    | 'user_aborted'
    | 'empty_section'
    | 'validation_failed';

export const MECHANICAL_TOOL_NAMES = [
  'storyOutlineBlock',
  'inventoryDeltas',
  'assetsDeltas',
  'plansDeltas',
  'techEquipmentUpdates',
  'magicSkillsUpdates',
  'worldFeaturesUpdates',
  'charactersToCreate',
  'factionsToCreate',
  'charactersToDelete',
  'factionsToDelete',
  'charactersToMove',
  'factionsToMove',
] as const;
export type MechanicalToolName = typeof MECHANICAL_TOOL_NAMES[number];
