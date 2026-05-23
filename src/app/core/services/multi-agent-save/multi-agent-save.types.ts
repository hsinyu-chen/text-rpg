/**
 * Shared types for the multi-agent save pipeline. Stage executors, data
 * providers, and the Debug UI all consume from here so a single type rename
 * propagates without import churn.
 *
 * Plan: TextRPG_Plans/doing/multi-agent-save-hunk-redesign.md
 */

import type { AgentLogEntry } from '../agent-runner/agent-runner.types';

/**
 * One condensed unit of "something happened in the ACT" extracted from a
 * single `role: 'model'` chat message.
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
 * prompt builders) can iterate with full type safety instead of casting
 * through `$any(event)[field]`.
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
 * breadcrumb (`# 核心人物 > ## 露娜`) — emitted as the `FileUpdate.context`
 * field so the matcher can locate the entry on apply.
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
 * `coreValues`).
 */
export interface FactionEntry {
  name: string;
  headingPath: string;
  /**
   * L1 ancestor heading text verbatim (e.g. `主要勢力`, `核心世界觀`,
   * `關鍵物品`). Like {@link CharacterEntry.group}, no whitelist —
   * downstream decides what to do with each group.
   */
  group: string;
  startLine: number;
  endLine: number;
  rawText: string;
}

// ============================================================================
// SaveAgent manifest — a flat list of hunks
// ============================================================================

/**
 * One verbatim edit the SaveAgent (or, later, an advanced-save agent) wants
 * applied to a KB file. The manifest is just `SaveHunk[]` — no envelope.
 *
 * The model writes `target` / `replacement` as finished markdown, looking at
 * the file's own format. No TypeScript layer renders structured fields into
 * markdown, so user-customised KB formats round-trip intact.
 *
 * Op semantics, decided by which fields are present:
 * - `target` omitted → append `replacement` at the end of the `context` section.
 * - `target` present, `replacement` non-empty → replace that exact substring.
 * - `target` present, `replacement` empty → delete that exact substring.
 *
 * `SaveHunk` is a distinct type from {@link import('../file-update.types').FileUpdate}:
 * they belong to different stages (manifest authoring vs. AutoUpdateDialog
 * apply, where `FileUpdate` carries matcher metadata like `beforeLines` /
 * `matchIndex`). A trivial mapper bridges the two.
 */
export interface SaveHunk {
  /**
   * Stable per-run hunk id (`H1` / `H2` …), assigned by the framework — NOT
   * authored by the LLM. Stamped when the manifest is validated; advanced-save
   * agents reference hunks by this id (drop / revise) and the chain keeps it
   * stable so a later agent can address an earlier agent's output. Short on
   * purpose: an LLM copies a printed id reliably but miscounts array indices.
   */
  id: string;
  /** Target KB filename — the model gives the locale-resolved actual name. */
  file: string;
  /** Heading breadcrumb crumbs (e.g. `["X", "Y"]`, outermost → innermost) for the matcher; empty array = file root. */
  context: string[];
  /** Exact existing text to replace / delete. Omit to append at the context section end. */
  target?: string;
  /** New content. Appended when `target` is omitted; empty + `target` set = delete. */
  replacement: string;
  /**
   * `ChatMessage.id` values from the current ACT that grounded this hunk.
   * Omit when the hunk is an inference without direct message evidence;
   * emit `[]` to explicitly mark "no anchors". Optional in v1 — the
   * validator does not enforce presence.
   */
  sourceMessageIds?: string[];
}

// ============================================================================
// Progress events — emitted by the SaveAgent runner for SaveProgressDialog
// to render per-entry cards.
// ============================================================================

export type SavePhase = 'manifest' | 'advanced-agent';
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
    /** Stage label (e.g. `SaveAgent`). */
    toolName?: string;
    /** For per-entity work: which entity is being updated. */
    entityName?: string;
    /** Streamed CoT — accumulated, shown in a collapsible details panel. */
    thought: string;
    /** Streamed structured output — JSON, shown in a code block when no `logs` are present. */
    output: string;
    /**
     * Structured agent trace, set by advanced-save agents mid-loop. When
     * present the dialog renders `<app-agent-trace-surface>` (rich cards with
     * thought / tool-call / tool-result folds + markdown) instead of the
     * `<pre>` fallback that `output` drives. Both fields can coexist (mainly
     * the SaveAgent has `output` and no `logs`; advanced agents have `logs`
     * and an empty `output`) — the template prefers `logs` when non-empty.
     */
    logs?: readonly AgentLogEntry[];
    /**
     * Framework-side notes about inputs the agent's terminal commit asked for
     * but the framework rejected (out-of-domain file, unknown id…). Rendered
     * below the trace in a "Framework Warnings" block — visible-by-default so
     * a save run's silent-skipped edits don't go unnoticed.
     */
    warnings?: readonly string[];
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
export type SaveSkipReason = 'user_aborted';
