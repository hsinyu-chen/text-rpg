import type { EntityUpdate } from '../multi-agent-save.types';
import { applySectionUpdates } from './section-update-handlers';
import type { MechanicalHandlerContext } from './protagonist-handlers';

/**
 * 1-call mode mechanical handler for `charactersToUpdate / factionsToUpdate`.
 *
 * Each {@link EntityUpdate} carries an optional `updates: SectionUpdate[]`
 * payload — when the main LLM ran in 1-call mode it filled this with full
 * SectionUpdate entries (each self-describes its `sectionPath` breadcrumb).
 * The handler flattens across entries and delegates to
 * {@link applySectionUpdates}, which is the same body used by
 * `techEquipmentUpdates / magicSkillsUpdates / worldFeaturesUpdates` —
 * meaning entity patches share the exact same grouping / dedup / degenerate-op
 * semantics as those slots, no parallel implementation.
 *
 * Entries with no `updates` (or empty arrays) are dropped at flatten time —
 * those represent "main LLM only flagged this entity for the multi-call
 * sub-agent to handle", which the dispatcher routes separately. Returns `''`
 * when nothing survives, same convention as the other handlers.
 */
export function applyEntityPatches(
    entries: readonly EntityUpdate[],
    ctx: MechanicalHandlerContext,
): string {
    const flatUpdates = entries.flatMap(e => e.updates ?? []);
    return applySectionUpdates(flatUpdates, ctx);
}
