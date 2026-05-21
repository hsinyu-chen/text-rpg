import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import type {
    AutoFixLog,
    CFixResult,
    EntityUpdate,
    InventoryDelta,
    SaveManifest,
    SectionUpdate,
} from '../multi-agent-save.types';
import { cFixInventory } from './c-fix-inventory';
import { cFixLifecycle } from './c-fix-lifecycle';
import { cFixPlans } from './c-fix-plans';
import { cFixSectionUpdates } from './c-fix-section';

export interface CFixRunnerInput {
    manifest: SaveManifest;
    kbFiles: ReadonlyMap<string, string>;
    coreFilenames: AppLocale['coreFilenames'];
}

/**
 * Composes every Sub-1 C-fix module in a single pass over the manifest.
 * See TextRPG_Plans/doing/multi-agent-save-per-domain-checks.md.
 *
 * Ordering:
 *  1. Inventory + Assets (independent slots)
 *  2. Plans (independent slot)
 *  3. Standalone `SectionUpdate[]` slots (tech / magic / world)
 *  4. Lifecycle (filters char/faction Delete/Move/Update across slots; also
 *     drops out-of-scope entity SectionUpdates — does NOT dedupe appends)
 *  5. Pure-append dedupe inside surviving `EntityUpdate.updates` — runs after
 *     lifecycle so dropped entities don't consume dedupe work
 *
 * Pure function; safe to call multiple times (re-entrant). Sub-3 will invoke
 * it a second time after A agents emit supplementaryHunks to dedupe any new
 * collisions.
 */
export function cFixRunner(input: CFixRunnerInput): CFixResult {
    const fixes: AutoFixLog[] = [];
    let m: SaveManifest = input.manifest;
    const files = input.kbFiles;
    const fn = input.coreFilenames;

    // 1. Inventory + Assets — same shape, different files.
    m = applyDeltaSlice(m, 'inventoryDeltas', files.get(fn.INVENTORY) ?? '', cFixInventory, fixes);
    m = applyDeltaSlice(m, 'assetsDeltas', files.get(fn.ASSETS) ?? '', cFixInventory, fixes);

    // 2. Plans.
    {
        const r = cFixPlans(m.plansDeltas ?? [], files.get(fn.PLANS) ?? '');
        m = { ...m, plansDeltas: r.deltas };
        fixes.push(...r.fixes);
    }

    // 3. Standalone SectionUpdate[] slots.
    m = applySectionSlice(m, 'techEquipmentUpdates', fixes);
    m = applySectionSlice(m, 'magicSkillsUpdates', fixes);
    m = applySectionSlice(m, 'worldFeaturesUpdates', fixes);

    // 4. Lifecycle — filters char/faction Delete/Move/Update slots, including
    // out-of-scope entity SectionUpdate drops + canonical-name rewrites.
    {
        const r = cFixLifecycle(m, files, fn);
        m = r.manifest;
        fixes.push(...r.fixes);
    }

    // 5. Pure-append dedupe inside surviving EntityUpdate.updates.
    m = applyEntityUpdatesDedup(m, 'charactersToUpdate', fixes);
    m = applyEntityUpdatesDedup(m, 'factionsToUpdate', fixes);

    return { manifest: m, fixes };
}

/**
 * Apply an inventory-shaped c-fix to one manifest slot keyed by `field`.
 * Internalizes the get-fix-set + accumulate-fixes pattern so the runner
 * stays a flat sequence of one-liners instead of six near-identical IIFEs.
 */
function applyDeltaSlice(
    m: SaveManifest,
    field: 'inventoryDeltas' | 'assetsDeltas',
    fileContent: string,
    fix: (deltas: readonly InventoryDelta[], fileContent: string) =>
        { deltas: InventoryDelta[]; fixes: AutoFixLog[] },
    fixes: AutoFixLog[],
): SaveManifest {
    const r = fix(m[field] ?? [], fileContent);
    fixes.push(...r.fixes);
    return { ...m, [field]: r.deltas };
}

/**
 * Apply the section-update c-fix to one of the standalone `SectionUpdate[]`
 * slots (`techEquipmentUpdates`, `magicSkillsUpdates`, `worldFeaturesUpdates`).
 */
function applySectionSlice(
    m: SaveManifest,
    field: 'techEquipmentUpdates' | 'magicSkillsUpdates' | 'worldFeaturesUpdates',
    fixes: AutoFixLog[],
): SaveManifest {
    const r = cFixSectionUpdates(m[field] ?? [], field);
    fixes.push(...r.fixes);
    return { ...m, [field]: r.updates };
}

/**
 * Run pure-append dedupe inside each surviving `EntityUpdate.updates` for the
 * named slot. Bare entries (sub-agent reservation, no `updates` payload) pass
 * through. Field label in fix reasons quotes the entity name so the trace
 * pins each dedupe to a specific entity.
 */
function applyEntityUpdatesDedup(
    m: SaveManifest,
    field: 'charactersToUpdate' | 'factionsToUpdate',
    fixes: AutoFixLog[],
): SaveManifest {
    const list = m[field];
    if (!list || list.length === 0) return m;
    const next: EntityUpdate[] = list.map(entry => {
        if (!entry.updates || entry.updates.length === 0) return entry;
        const r = cFixSectionUpdates(entry.updates, `${field}["${entry.name}"]`);
        fixes.push(...r.fixes);
        return { ...entry, updates: r.updates as SectionUpdate[] };
    });
    return { ...m, [field]: next };
}
