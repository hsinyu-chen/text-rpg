/**
 * Derives the current act number from the Knowledge Base files for naming
 * save slots / the next book. The act ledger lives in the KB (e.g. the story
 * outline accumulates `## Act.N` headers as the story is saved), NOT in chat —
 * the chat-header source was removed with the inline auto-save block.
 *
 * Loose matching by design: users/LLMs dirty the format. We only trust ATX
 * heading lines, and within them accept `ACT <num>` (any separators) or
 * `第 <num> 章/節/幕`, taking the highest number found across all files.
 */
const ATX_HEADER = /^#{1,6}\s/;
// \b keeps "react.2" from matching, and the digit must immediately follow the
// (optional) separators, so "Active Quests 5" / "Activity 3" still don't match
// while "Act.3" / "Act 3" / "Act3" all do.
const EN_ACT = /\bAct[.\s:-]*(\d+)/i;
// Restrict the gaps to punctuation/whitespace so prose like "第 2 頁的章節"
// (page 2's chapters) is not misread as act 2.
const ZH_ACT = /第[.\s:-]*(\d+)[.\s:-]*[章節幕]/;

export function extractActNumberFromKb(files: Map<string, string>): number | null {
    let max: number | null = null;
    const take = (n: number) => { if (!Number.isNaN(n) && (max === null || n > max)) max = n; };

    for (const content of files.values()) {
        if (!content) continue;
        for (const line of content.split('\n')) {
            if (!ATX_HEADER.test(line)) continue;
            const en = line.match(EN_ACT);
            if (en) take(parseInt(en[1], 10));
            const zh = line.match(ZH_ACT);
            if (zh) take(parseInt(zh[1], 10));
        }
    }

    return max;
}

/** Canonical display name for an act number, e.g. `3` -> `Act.3`. */
export function formatActName(n: number): string {
    return `Act.${n}`;
}
