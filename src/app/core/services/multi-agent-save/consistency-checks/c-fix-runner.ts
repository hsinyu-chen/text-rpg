import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import type { AutoFixLog, CFixResult, SaveManifest } from '../multi-agent-save.types';
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

    // 1. Inventory + Assets (same shape, different files).
    {
        const r = cFixInventory(m.inventoryDeltas ?? [], files.get(fn.INVENTORY) ?? '');
        m = { ...m, inventoryDeltas: r.deltas };
        fixes.push(...r.fixes);
    }
    {
        const r = cFixInventory(m.assetsDeltas ?? [], files.get(fn.ASSETS) ?? '');
        m = { ...m, assetsDeltas: r.deltas };
        fixes.push(...r.fixes);
    }

    // 2. Plans.
    {
        const r = cFixPlans(m.plansDeltas ?? [], files.get(fn.PLANS) ?? '');
        m = { ...m, plansDeltas: r.deltas };
        fixes.push(...r.fixes);
    }

    // 3. Standalone SectionUpdate[] slots.
    {
        const r = cFixSectionUpdates(m.techEquipmentUpdates ?? [], 'techEquipmentUpdates');
        m = { ...m, techEquipmentUpdates: r.updates };
        fixes.push(...r.fixes);
    }
    {
        const r = cFixSectionUpdates(m.magicSkillsUpdates ?? [], 'magicSkillsUpdates');
        m = { ...m, magicSkillsUpdates: r.updates };
        fixes.push(...r.fixes);
    }
    {
        const r = cFixSectionUpdates(m.worldFeaturesUpdates ?? [], 'worldFeaturesUpdates');
        m = { ...m, worldFeaturesUpdates: r.updates };
        fixes.push(...r.fixes);
    }

    // 4. Lifecycle — filters char/faction Delete/Move/Update slots, including
    // out-of-scope entity SectionUpdate drops.
    {
        const r = cFixLifecycle(m, files, fn);
        m = r.manifest;
        fixes.push(...r.fixes);
    }

    // 5. Pure-append dedupe inside surviving EntityUpdate.updates.
    if (m.charactersToUpdate && m.charactersToUpdate.length > 0) {
        const next = m.charactersToUpdate.map(entry => {
            if (!entry.updates || entry.updates.length === 0) return entry;
            const r = cFixSectionUpdates(entry.updates, `charactersToUpdate["${entry.name}"]`);
            fixes.push(...r.fixes);
            return { ...entry, updates: r.updates };
        });
        m = { ...m, charactersToUpdate: next };
    }
    if (m.factionsToUpdate && m.factionsToUpdate.length > 0) {
        const next = m.factionsToUpdate.map(entry => {
            if (!entry.updates || entry.updates.length === 0) return entry;
            const r = cFixSectionUpdates(entry.updates, `factionsToUpdate["${entry.name}"]`);
            fixes.push(...r.fixes);
            return { ...entry, updates: r.updates };
        });
        m = { ...m, factionsToUpdate: next };
    }

    return { manifest: m, fixes };
}
