import { Injectable, inject } from '@angular/core';
import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import {
    MECHANICAL_TOOL_NAMES,
    type MechanicalToolName,
    type SaveManifest,
} from './multi-agent-save.types';
import { MECHANICAL_HANDLERS, targetFileFor } from './mechanical-handlers';
import { SaveProgressTracker } from './progress/save-progress-tracker.service';

export interface DispatchInput {
    manifest: SaveManifest;
    /** Active locale's coreFilenames map — handler `targetFile` resolution. */
    coreFilenames: AppLocale['coreFilenames'];
    /** Snapshot of loaded KB files at save time — handlers use this for line-lookups. */
    kbFiles: ReadonlyMap<string, string>;
}

export interface DispatchResult {
    /** Concatenated `<save>` XML blocks ready for FileUpdateParser. */
    xml: string;
    /** How many tools actually emitted XML (state: 'done'). */
    doneCount: number;
    /** How many tools were skipped (`empty_section` + `not_yet_implemented`). */
    skippedCount: number;
    /** How many tools were skipped specifically as `not_yet_implemented`. */
    notYetImplementedCount: number;
}

/**
 * Walks every mechanical-section slot on the manifest and:
 * - if the slot is wired in {@link MECHANICAL_HANDLERS} → invokes the handler,
 *   emits a progress entry recording the per-tool outcome
 * - if the slot is empty or not wired → emits a `skipped` progress entry with
 *   the reason code (`empty_section` / `not_yet_implemented`)
 *
 * LLM sub-tool fields (`charactersToUpdate` / `factionsToUpdate`) are NOT
 * touched here — those are dispatched by `UpdateCharacterChain` /
 * `UpdateFactionChain` in a later phase. For Phase 1 the dispatcher just
 * emits one skip entry per non-empty LLM section.
 *
 * The dispatcher does NOT throw on handler errors — it converts them to
 * `failed` progress entries and continues, so a single bad section doesn't
 * abort the entire save.
 */
@Injectable({ providedIn: 'root' })
export class SubToolDispatcherService {
    private progress = inject(SaveProgressTracker);

    dispatch(input: DispatchInput): DispatchResult {
        const xmlParts: string[] = [];
        let doneCount = 0;
        let skippedCount = 0;
        let notYetImplementedCount = 0;

        for (const tool of MECHANICAL_TOOL_NAMES) {
            const entryId = this.progress.startEntry('sub-tool', { toolName: tool });

            if (!hasContent(input.manifest, tool)) {
                this.progress.skip(entryId, 'empty_section');
                skippedCount++;
                continue;
            }

            const handler = MECHANICAL_HANDLERS[tool];
            if (!handler) {
                this.progress.skip(entryId, 'not_yet_implemented');
                skippedCount++;
                notYetImplementedCount++;
                continue;
            }

            const targetFile = targetFileFor(tool, input.coreFilenames);
            if (!targetFile) {
                // Belt-and-suspenders: a handler is registered but
                // targetFileFor returns null. Treat as unimplemented rather
                // than crashing.
                this.progress.skip(entryId, 'not_yet_implemented');
                skippedCount++;
                notYetImplementedCount++;
                continue;
            }

            const fileContent = input.kbFiles.get(targetFile) ?? '';
            try {
                const xml = handler(input.manifest, { targetFile, fileContent });
                if (!xml) {
                    // Handler ran but every op was dropped (e.g. all
                    // `remove`s missed the line lookup). Same UX as an empty
                    // section.
                    this.progress.skip(entryId, 'empty_section');
                    skippedCount++;
                    continue;
                }
                xmlParts.push(xml);
                this.progress.appendOutput(entryId, xml);
                this.progress.finishEntry(entryId, 'done');
                doneCount++;
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.progress.finishEntry(entryId, 'failed', msg);
                // Failed sections do NOT count as skipped — caller can read
                // the entries() array to discover failures.
            }
        }

        // LLM sub-tool sections: Phase 1 just records skip entries. Skipping
        // empty sections silently here keeps the dialog free of N empty
        // "charactersToUpdate" cards when the manifest didn't request any.
        for (const tool of ['charactersToUpdate', 'factionsToUpdate'] as const) {
            const list = input.manifest[tool];
            if (list && list.length > 0) {
                const entryId = this.progress.startEntry('sub-tool', { toolName: tool });
                this.progress.skip(entryId, 'not_yet_implemented');
                skippedCount++;
                notYetImplementedCount++;
            }
        }

        return {
            xml: xmlParts.join('\n'),
            doneCount,
            skippedCount,
            notYetImplementedCount,
        };
    }
}

/**
 * True when the manifest slot has at least one entry. `storyOutlineBlock` is
 * a string field; the rest are arrays. Empty arrays / empty strings count as
 * "no work to do here" and the dispatcher emits an `empty_section` skip.
 */
function hasContent(manifest: SaveManifest, tool: MechanicalToolName): boolean {
    if (tool === 'storyOutlineBlock') {
        return !!manifest.storyOutlineBlock && manifest.storyOutlineBlock.length > 0;
    }
    const value = manifest[tool];
    return Array.isArray(value) && value.length > 0;
}
