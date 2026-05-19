import type { SectionUpdate } from '../multi-agent-save.types';
import { saveBlock, type SaveUpdateOp } from '../utils/serialize-save-block.util';
import { pushToMap } from '../utils/handler-helpers.util';
import type { MechanicalHandlerContext } from './protagonist-handlers';

/**
 * Shared handler for the three section-update manifest slots
 * (`techEquipmentUpdates` / `magicSkillsUpdates` / `worldFeaturesUpdates`).
 *
 * Each {@link SectionUpdate} carries an existing `sectionPath` plus either a
 * `target` (replace exact substring inside that section) or no target (append
 * `replacement` at section end). This mirrors the legacy `<save>` XML format
 * 1:1 — see `partials/save-xml-format.md`.
 *
 * Entries are grouped by `sectionPath` so multiple replacements on the same
 * section land in a single `<save>` block. Degenerate ops are dropped at the
 * handler boundary:
 * - `target` omitted AND `replacement` empty → nothing to append
 * - `target` present but empty string → would match every position; refuse
 *
 * Returns `''` when every entry was empty / dropped; the dispatcher reads that
 * as `empty_section` so a no-op section doesn't render a `done` entry.
 */
export function applySectionUpdates(
    updates: readonly SectionUpdate[],
    ctx: MechanicalHandlerContext,
): string {
    if (updates.length === 0) return '';

    // Insertion-ordered grouping: keeps the manifest order stable in the
    // emitted XML, which makes the trace / progress output predictable.
    const grouped = new Map<string, SaveUpdateOp[]>();
    for (const u of updates) {
        if (!u.sectionPath) continue;
        if (u.target === undefined) {
            // Append at section end. An empty replacement here would emit a
            // `<replacement></replacement>` no-op that bloats trace output
            // without changing the file — skip it.
            if (!u.replacement) continue;
            pushToMap(grouped, u.sectionPath, { kind: 'append', replacement: u.replacement });
        } else {
            // Replace exact substring. Empty target is degenerate (matches
            // every position); skip rather than emit broken XML.
            if (!u.target) continue;
            pushToMap(grouped, u.sectionPath, { kind: 'replace', target: u.target, replacement: u.replacement });
        }
    }

    if (grouped.size === 0) return '';

    return [...grouped.entries()]
        .map(([sectionPath, ops]) => saveBlock(ctx.targetFile, sectionPath, ops))
        .filter(s => s.length > 0)
        .join('\n');
}
