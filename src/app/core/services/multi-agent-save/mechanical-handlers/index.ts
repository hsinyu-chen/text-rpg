import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import type { MechanicalToolName, SaveManifest } from '../multi-agent-save.types';
import { applyInventoryDeltas, type MechanicalHandlerContext } from './protagonist-handlers';

type CoreFilenames = AppLocale['coreFilenames'];

/**
 * A mechanical handler's runtime contract:
 *
 * - `manifest` — the full SaveAgent manifest; the handler picks its own slice
 *   from it. Passing the whole manifest (rather than slicing per-tool in the
 *   dispatcher) keeps the per-tool TS type narrow at the call site and lets a
 *   single handler look at sibling sections if it ever needs to.
 * - `ctx` — the dispatcher-assembled context (target file name + file contents
 *   for line-lookups).
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
 * Returns `null` for tools the registry has not wired yet (Phase 1: only
 * `inventoryDeltas`). The dispatcher reads `null` as the cue to mark the
 * entry `skipped: not_yet_implemented`.
 */
export function targetFileFor(tool: MechanicalToolName, files: CoreFilenames): string | null {
    switch (tool) {
        case 'inventoryDeltas': return files.INVENTORY;
        case 'assetsDeltas':
        case 'plansDeltas':
        case 'storyOutlineBlock':
        case 'techEquipmentUpdates':
        case 'magicSkillsUpdates':
        case 'worldFeaturesUpdates':
        case 'charactersToCreate':
        case 'factionsToCreate':
        case 'charactersToDelete':
        case 'factionsToDelete':
        case 'charactersToMove':
        case 'factionsToMove':
            return null;
    }
}

/**
 * Registry of wired mechanical handlers. The dispatcher iterates
 * `MECHANICAL_TOOL_NAMES` and looks up here; absence ≡ "Phase 1 doesn't
 * implement this tool yet". The dispatcher emits a `not_yet_implemented`
 * skip in that case, so SaveAgent's manifest can still drive a partial save
 * end-to-end while the remaining handlers land in follow-up commits.
 */
export const MECHANICAL_HANDLERS: Partial<Record<MechanicalToolName, MechanicalHandler>> = {
    inventoryDeltas: (manifest, ctx) => applyInventoryDeltas(manifest.inventoryDeltas ?? [], ctx),
};
