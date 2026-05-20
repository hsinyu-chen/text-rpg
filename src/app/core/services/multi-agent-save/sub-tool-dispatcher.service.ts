import { Injectable, inject } from '@angular/core';
import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import {
    MECHANICAL_TOOL_NAMES,
    type EntityUpdate,
    type MechanicalToolName,
    type SaveManifest,
} from './multi-agent-save.types';
import { MECHANICAL_HANDLERS, entityUpdateTargetFile, targetFileFor, type EntityUpdateToolName } from './mechanical-handlers';
import { applyEntityPatches } from './mechanical-handlers/entity-patch-handlers';
import { SaveProgressTracker } from './progress/save-progress-tracker.service';

export interface DispatchInput {
    manifest: SaveManifest;
    /** Active locale's coreFilenames map — handler `targetFile` resolution. */
    coreFilenames: AppLocale['coreFilenames'];
    /**
     * Active locale's KB section heading map. Handlers that pin
     * `<save context="…">` to a locale-specific heading (e.g. story-outline)
     * read from this.
     */
    kbSectionHeadings: AppLocale['kbSectionHeadings'];
    /** Snapshot of loaded KB files at save time — handlers use this for line-lookups. */
    kbFiles: ReadonlyMap<string, string>;
}

export interface DispatchResult {
    /** Concatenated `<save>` XML blocks ready for FileUpdateParser. */
    xml: string;
}

/**
 * Walks every mechanical-section slot on the manifest and:
 * - if the slot is wired in {@link MECHANICAL_HANDLERS} → invokes the handler,
 *   emits a progress entry recording the per-tool outcome
 * - if the slot is empty or not wired → emits a `skipped` progress entry with
 *   the reason code (`empty_section` / `not_yet_implemented`)
 *
 * Entity-update slots (`charactersToUpdate` / `factionsToUpdate`) are dual-
 * natured and dispatched in their own block:
 * - entries carrying `updates: SectionUpdate[]` → 1-call mode mechanical
 *   handler {@link applyEntityPatches}
 * - entries with only `name` + `reasonHint` → reserved for Phase B
 *   per-entity sub-agent; currently emit `not_yet_implemented` skip
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

        for (const tool of MECHANICAL_TOOL_NAMES) {
            const entryId = this.progress.startEntry('sub-tool', { toolName: tool });

            if (!hasContent(input.manifest, tool)) {
                this.progress.skip(entryId, 'empty_section');
                continue;
            }

            const handler = MECHANICAL_HANDLERS[tool];
            if (!handler) {
                this.progress.skip(entryId, 'not_yet_implemented');
                continue;
            }

            const targetFile = targetFileFor(tool, input.coreFilenames);
            if (!targetFile) {
                // Belt-and-suspenders: a handler is registered but
                // targetFileFor returns null. Treat as unimplemented rather
                // than crashing.
                this.progress.skip(entryId, 'not_yet_implemented');
                continue;
            }

            const fileContent = input.kbFiles.get(targetFile) ?? '';
            try {
                const xml = handler(input.manifest, {
                    targetFile,
                    fileContent,
                    kbSectionHeadings: input.kbSectionHeadings,
                });
                if (!xml) {
                    // Handler ran but every op was dropped (e.g. all
                    // `remove`s missed the line lookup). Same UX as an empty
                    // section.
                    this.progress.skip(entryId, 'empty_section');
                    continue;
                }
                xmlParts.push(xml);
                this.progress.appendOutput(entryId, xml);
                this.progress.finishEntry(entryId, 'done');
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.progress.finishEntry(entryId, 'failed', msg);
            }
        }

        // Entity-update sections: route by whether each entry carries an
        // `updates` SectionUpdate[] payload.
        //  - 1-call mode: main LLM filled `updates` directly → mechanical
        //    handler (applyEntityPatches) emits XML in this dispatch.
        //  - multi-call mode: entry has only name + reasonHint → reserved
        //    for the Phase B per-entity sub-agent; emit not_yet_implemented.
        // Empty sections are skipped silently so the dialog isn't padded
        // with N empty cards.
        for (const tool of ['charactersToUpdate', 'factionsToUpdate'] as const) {
            const list = input.manifest[tool];
            if (!list || list.length === 0) continue;
            this.dispatchEntityUpdates(tool, list, input, xmlParts);
        }

        return { xml: xmlParts.join('\n') };
    }

    private dispatchEntityUpdates(
        tool: EntityUpdateToolName,
        entries: readonly EntityUpdate[],
        input: DispatchInput,
        xmlParts: string[],
    ): void {
        const mechanicalEntries = entries.filter(e => e.updates && e.updates.length > 0);
        const subAgentEntries = entries.filter(e => !e.updates || e.updates.length === 0);

        if (mechanicalEntries.length > 0) {
            const entryId = this.progress.startEntry('sub-tool', { toolName: tool });
            const targetFile = entityUpdateTargetFile(tool, input.coreFilenames);
            const fileContent = input.kbFiles.get(targetFile) ?? '';
            try {
                const xml = applyEntityPatches(mechanicalEntries, {
                    targetFile,
                    fileContent,
                    kbSectionHeadings: input.kbSectionHeadings,
                });
                if (!xml) {
                    this.progress.skip(entryId, 'empty_section');
                } else {
                    xmlParts.push(xml);
                    this.progress.appendOutput(entryId, xml);
                    this.progress.finishEntry(entryId, 'done');
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.progress.finishEntry(entryId, 'failed', msg);
            }
        }

        // Sub-agent entries get their own skip entry so the user sees that
        // Phase B work was requested but not run yet — co-existence with a
        // mechanical entry above means the manifest mixed both, which is a
        // legitimate (if unusual) state under partial 1-call coverage.
        if (subAgentEntries.length > 0) {
            const entryId = this.progress.startEntry('sub-tool', { toolName: tool });
            this.progress.skip(entryId, 'not_yet_implemented');
        }
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
