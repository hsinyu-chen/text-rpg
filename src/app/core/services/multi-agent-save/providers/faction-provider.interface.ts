import { FactionEntry } from '../multi-agent-save.types';

/**
 * Source of faction entries for the multi-agent save pipeline.
 *
 * Phase 1 default: {@link import('./markdown-faction.provider').MarkdownFactionProvider}
 * — parses `6.勢力與世界.md` for level-2 headings under any L1 ancestor.
 *
 * Phase 4 (deferred): swap to an LLM-extracting implementation that handles
 * author-customized KB schemas. Orchestrator depends only on this interface,
 * so the binding swap is the only change point.
 */
export interface FactionProvider {
  /**
   * Returns every faction entry found in the supplied KB files. Empty
   * array when the source file is missing or has no L2 entries — never
   * throws on structural absence.
   *
   * Return type is `T | PromiseLike<T>` so sync implementations (Phase 1
   * markdown) don't need a `Promise.resolve` wrap, while async ones
   * (Phase 4 LLM extraction) plug in without a breaking signature change.
   * Callers always `await`.
   */
  listFactions(kbFiles: ReadonlyMap<string, string>): FactionEntry[] | PromiseLike<FactionEntry[]>;
}
