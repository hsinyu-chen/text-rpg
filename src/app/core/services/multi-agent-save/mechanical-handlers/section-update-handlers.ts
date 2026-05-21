import type { FileUpdate } from '../../file-update.types';
import type { SectionUpdate } from '../multi-agent-save.types';
import { opsToFileUpdates, type SaveUpdateOp } from '../utils/file-update-ops.util';
import { pushToMap } from '../utils/handler-helpers.util';
import type { MechanicalHandlerContext } from './protagonist-handlers';

/**
 * Shared handler for the three section-update manifest slots
 * (`techEquipmentUpdates` / `magicSkillsUpdates` / `worldFeaturesUpdates`).
 *
 * Each {@link SectionUpdate} carries an existing `sectionPath` plus either a
 * `target` (replace exact substring inside that section) or no target (append
 * `replacement` at section end).
 *
 * Entries are grouped by `sectionPath` so the trace output keeps the per-section
 * batching that was previously expressed by sharing one `<save>` block. Degenerate
 * ops are dropped at the handler boundary:
 * - `target` omitted AND `replacement` empty → nothing to append
 * - `target` present but empty string → would match every position; refuse
 *
 * Returns `[]` when every entry was empty / dropped; the dispatcher reads that
 * as `empty_section` so a no-op section doesn't render a `done` entry.
 */
export function applySectionUpdates(
    updates: readonly SectionUpdate[],
    ctx: MechanicalHandlerContext,
): FileUpdate[] {
    if (updates.length === 0) return [];

    // Insertion-ordered grouping: keeps the manifest order stable in the
    // emitted updates, which makes the trace / progress output predictable.
    const grouped = new Map<string, SaveUpdateOp[]>();
    for (const u of updates) {
        if (!u.sectionPath) continue;
        if (u.target === undefined) {
            // Append at section end. An empty replacement here would emit a
            // no-op that bloats trace output without changing the file —
            // skip it.
            if (!u.replacement) continue;
            pushToMap(grouped, u.sectionPath, { kind: 'append', replacement: u.replacement });
        } else {
            // Replace exact substring. Empty target is degenerate (matches
            // every position); skip rather than emit a broken hunk.
            if (!u.target) continue;
            pushToMap(grouped, u.sectionPath, { kind: 'replace', target: u.target, replacement: u.replacement });
        }
    }

    if (grouped.size === 0) return [];

    return [...grouped.entries()]
        .flatMap(([sectionPath, ops]) => opsToFileUpdates(ctx.targetFile, sectionPath, ops));
}
