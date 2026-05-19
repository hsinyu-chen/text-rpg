import { CharacterEntry } from '../multi-agent-save.types';

/**
 * Source of NPC entries for the multi-agent save pipeline.
 *
 * Phase 1 default: {@link import('./markdown-character.provider').MarkdownCharacterProvider}
 * — parses `3.人物狀態.md` for level-2 headings under the configured group
 * sections.
 *
 * Phase 4 (deferred): swap to an LLM-extracting implementation that handles
 * author-customized KB schemas. Orchestrator depends only on this interface,
 * so the binding swap is the only change point.
 */
export interface CharacterProvider {
  /**
   * Returns every NPC entry found in the supplied KB files. Empty array when
   * the source file is missing or has no matching entries — never throws on
   * structural absence.
   *
   * Return type is `T | PromiseLike<T>` so sync implementations (Phase 1
   * markdown) don't need a `Promise.resolve` wrap, while async ones
   * (Phase 4 LLM extraction) plug in without a breaking signature change.
   * Callers always `await`.
   */
  listCharacters(kbFiles: ReadonlyMap<string, string>): CharacterEntry[] | PromiseLike<CharacterEntry[]>;
}
