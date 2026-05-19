import { saveBlock } from '../utils/serialize-save-block.util';
import type { MechanicalHandlerContext } from './protagonist-handlers';

/**
 * Pure-append handler for `storyOutlineBlock`. SaveAgent emits the entire
 * `## Act.N - Title` block for this ACT as one string; we just wrap it in a
 * `<save>` block.
 *
 * The append goes under `# {locale chronicle heading}` — the Story Outline
 * file has a separate "Story Guide" heading at the top (intro content) that
 * must NOT receive ACT entries. Pinning the context to the chronicle heading
 * keeps the FileUpdateParser from appending to the wrong one.
 *
 * No dedup, no chronological-ordering — SaveAgent owns idempotency. An empty
 * string returns '', surfaced by the dispatcher as `empty_section`.
 */
export function writeStoryOutlineBlock(
    block: string | undefined,
    ctx: MechanicalHandlerContext,
): string {
    if (!block) return '';
    const trimmed = block.trim();
    if (!trimmed) return '';
    const heading = ctx.kbSectionHeadings.STORY_OUTLINE_CHRONICLE;
    if (!heading) return '';
    // Leading `\n` separates this ACT block from the preceding chronicle
    // content; no trailing `\n` because the NEXT ACT append brings its own
    // leading `\n` — trailing here would stack a second blank line every
    // save. Matches `renderEntityBody` / `renderPlanBlock` shape.
    return saveBlock(ctx.targetFile, `# ${heading}`, [
        { kind: 'append', replacement: `\n${trimmed}` },
    ]);
}
