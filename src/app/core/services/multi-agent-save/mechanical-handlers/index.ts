import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import type { MechanicalToolName, SaveManifest } from '../multi-agent-save.types';
import { applyInventoryDeltas, applyPlansDeltas, type MechanicalHandlerContext } from './protagonist-handlers';
import { writeStoryOutlineBlock } from './story-outline-handlers';
import { applySectionUpdates } from './section-update-handlers';
import { createEntities, deleteEntities, moveEntities } from './entity-lifecycle-handlers';

type CoreFilenames = AppLocale['coreFilenames'];

/**
 * Entity-update tools live outside {@link MechanicalToolName} because they
 * have a dual nature: 1-call mode routes them through `applyEntityPatches`
 * (mechanical), multi-call mode hands them to a per-entity sub-agent
 * (Phase B). The dispatcher inspects each entry's `updates` field to pick the
 * route; both routes need the same KB target-file mapping, captured here.
 */
export type EntityUpdateToolName = 'charactersToUpdate' | 'factionsToUpdate';

/**
 * Resolves the KB file an entity-update tool targets, from the active locale's
 * `coreFilenames` map. Mirrors {@link targetFileFor} for the entity-update
 * surface; kept separate because `EntityUpdateToolName` is intentionally not
 * a member of `MechanicalToolName`.
 */
export function entityUpdateTargetFile(tool: EntityUpdateToolName, files: CoreFilenames): string {
    return tool === 'charactersToUpdate' ? files.CHARACTER_STATUS : files.WORLD_FACTIONS;
}

/**
 * A mechanical handler's runtime contract:
 *
 * - `manifest` — the full SaveAgent manifest; the handler picks its own slice
 *   from it. Passing the whole manifest (rather than slicing per-tool in the
 *   dispatcher) keeps the per-tool TS type narrow at the call site and lets a
 *   single handler look at sibling sections if it ever needs to.
 * - `ctx` — the dispatcher-assembled context (target file name + file contents
 *   for line-lookups + locale heading map).
 *
 * Returns the `<save>...</save>` XML fragment, or `''` when the relevant
 * manifest slice was empty / no ops survived (dispatcher then marks the
 * entry `skipped: empty_section`).
 */
export type MechanicalHandler = (manifest: SaveManifest, ctx: MechanicalHandlerContext) => string;

/**
 * Resolves the KB file each mechanical tool targets, from the active
 * locale's `coreFilenames` map.
 *
 * Single source of truth for "which file does this manifest section update".
 * Used by the dispatcher to build the {@link MechanicalHandlerContext}
 * before invoking the registry entry.
 *
 * Returns `null` only for tools the registry has not wired yet; today every
 * `MechanicalToolName` resolves to a file. The dispatcher reads `null` as
 * the cue to mark the entry `skipped: not_yet_implemented`.
 */
export function targetFileFor(tool: MechanicalToolName, files: CoreFilenames): string | null {
    switch (tool) {
        case 'inventoryDeltas': return files.INVENTORY;
        case 'assetsDeltas': return files.ASSETS;
        case 'plansDeltas': return files.PLANS;
        case 'storyOutlineBlock': return files.STORY_OUTLINE;
        case 'techEquipmentUpdates': return files.TECH_EQUIPMENT;
        case 'magicSkillsUpdates': return files.MAGIC;
        case 'worldFeaturesUpdates': return files.WORLD_FACTIONS;
        case 'charactersToCreate':
        case 'charactersToDelete':
        case 'charactersToMove':
            return files.CHARACTER_STATUS;
        case 'factionsToCreate':
        case 'factionsToDelete':
        case 'factionsToMove':
            return files.WORLD_FACTIONS;
    }
}

/**
 * Registry of wired mechanical handlers. The dispatcher iterates
 * `MECHANICAL_TOOL_NAMES` and looks up here; absence ≡ "tool not implemented",
 * surfaced as a `not_yet_implemented` skip in progress trace. Phase 1 A2 wires
 * every mechanical tool; the only remaining gap is the LLM sub-tools
 * (`charactersToUpdate` / `factionsToUpdate`), which the dispatcher routes
 * separately.
 *
 * Character + faction lifecycle entries share the same helper because the
 * type, mechanics, and file shape are identical — only `ctx.targetFile`
 * differs, and that's resolved by {@link targetFileFor}.
 */
export const MECHANICAL_HANDLERS: Partial<Record<MechanicalToolName, MechanicalHandler>> = {
    inventoryDeltas: (m, ctx) => applyInventoryDeltas(m.inventoryDeltas ?? [], ctx),
    assetsDeltas: (m, ctx) => applyInventoryDeltas(m.assetsDeltas ?? [], ctx),
    plansDeltas: (m, ctx) => applyPlansDeltas(m.plansDeltas ?? [], ctx),
    storyOutlineBlock: (m, ctx) => writeStoryOutlineBlock(m.storyOutlineBlock, ctx),
    techEquipmentUpdates: (m, ctx) => applySectionUpdates(m.techEquipmentUpdates ?? [], ctx),
    magicSkillsUpdates: (m, ctx) => applySectionUpdates(m.magicSkillsUpdates ?? [], ctx),
    worldFeaturesUpdates: (m, ctx) => applySectionUpdates(m.worldFeaturesUpdates ?? [], ctx),
    charactersToCreate: (m, ctx) => createEntities(m.charactersToCreate ?? [], ctx),
    factionsToCreate: (m, ctx) => createEntities(m.factionsToCreate ?? [], ctx),
    charactersToDelete: (m, ctx) => deleteEntities(m.charactersToDelete ?? [], ctx),
    factionsToDelete: (m, ctx) => deleteEntities(m.factionsToDelete ?? [], ctx),
    charactersToMove: (m, ctx) => moveEntities(m.charactersToMove ?? [], ctx),
    factionsToMove: (m, ctx) => moveEntities(m.factionsToMove ?? [], ctx),
};
