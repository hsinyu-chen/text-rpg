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
