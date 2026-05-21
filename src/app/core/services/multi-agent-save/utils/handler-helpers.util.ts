import { findMarkdownSections } from '@app/core/services/file-agent/markdown-section.util';

/**
 * Strips a leading ATX heading prefix (`#`, `##`, … plus any whitespace) off
 * model-supplied text. Used at every spot where the manifest hands us a
 * "heading text verbatim" string and we prepend our own `#` count: the schema
 * description is ambiguous, and local models occasionally include the prefix
 * themselves, which would otherwise round-trip as `# # 核心人物` and silently
 * break heading-path lookups.
 *
 * Returns the input unchanged when no prefix is present.
 */
export function stripHeadingPrefix(text: string): string {
    return text.replace(/^#+\s*/, '');
}

/**
 * Insertion-ordered map-push: `(map[key] ??= []).push(value)` without the
 * pitfalls of nullish-assignment on Map values. Shared across mechanical
 * handlers that group XML ops by some key (sectionPath, L1 group, etc.).
 */
export function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}

/**
 * Looks up a single L2 markdown section by ATX path and returns its verbatim
 * block text (from the heading line through the last body line), suitable
 * for use as a `<target>` in a `<save>` op.
 *
 * Returns `null` for both "not found" AND "ambiguous" (multiple matches) —
 * Phase 1 doesn't disambiguate same-named sections under different L1 parents.
 * Callers (entity-lifecycle delete/move, plans remove/update) silently drop
 * the offending op rather than guess.
 *
 * Pass a pre-split `lines` array alongside `content` so caller-side loops
 * over many keys can split once and reuse — `findMarkdownSections` re-splits
 * internally, but the slice phase here is per-call.
 */
export function lookupSectionBlock(
    content: string,
    lines: readonly string[],
    atxPath: string,
): string | null {
    if (!atxPath) return null;
    const matches = findMarkdownSections(content, atxPath);
    if (matches.length !== 1) return null;
    const { startLine, endLine } = matches[0];
    return lines.slice(startLine, endLine + 1).join('\n');
}

/**
 * Builds the ATX path for a plan L2 block from a model-supplied plan title.
 *
 * The KB template wraps plan headings as `## 「{title}」計畫` (zh-tw); models
 * occasionally include the brackets and/or `計畫` suffix in the `title` field
 * itself, which would round-trip into `## 「「foo」計畫」計畫` and silently
 * break heading-path lookups. The triple-replace strips whichever boundary
 * the model shipped so we re-wrap exactly once.
 *
 * zh-tw-specific today — the en blank-world template doesn't ship a Plans
 * file. When en plans land, this wrap moves into `AppLocale.kbSectionHeadings`
 * alongside the chronicle heading and gets a locale parameter here.
 */
export function derivePlanAtxPath(title: string): string {
    const bareTitle = title.replace(/^「/, '').replace(/」計畫$/, '').replace(/」$/, '');
    return `## 「${bareTitle}」計畫`;
}

/**
 * Union two optional sourceMessageIds arrays, deduped, order-preserving
 * (`a` first, then `b` items not in `a`). Used when c-fix merges two ops
 * into one and both contributed to the final state (pure-append merge,
 * same-canonical-name EntityUpdate merge):
 *
 * - both undefined / empty → undefined (no field set on output)
 * - either side has content → union
 *
 * Intentionally returns `undefined` rather than `[]` when nothing to merge,
 * so callers' spread doesn't materialize the field on the output object.
 * (Matches the convention used by `OpEvidence.sourceMessageIds` — omission
 * means "inferred / no anchors", which is the default.)
 */
export function unionSourceMessageIds(
    a: readonly string[] | undefined,
    b: readonly string[] | undefined,
): string[] | undefined {
    if ((!a || a.length === 0) && (!b || b.length === 0)) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    if (a) for (const id of a) if (!seen.has(id)) { seen.add(id); out.push(id); }
    if (b) for (const id of b) if (!seen.has(id)) { seen.add(id); out.push(id); }
    return out;
}

/**
 * Last-wins dedup: returns the items whose `keyFn(item)` is unique among the
 * input, keeping the *last* occurrence of each key. Dropped earlier-occurrence
 * items are passed to `onDropped` so the caller can emit per-domain fix logs.
 *
 * Shared by all c-fix slices (inventory / plans / lifecycle) — each had a
 * hand-rolled `lastIndex` Map loop before. The pattern exists because every
 * downstream mechanical handler anchors ops to the file's *original* state;
 * two surviving ops on the same key both anchor to the same line/block and
 * the second hunk fails on apply, losing data. Last-wins per key prevents
 * the anchor-conflict failure mode.
 *
 * O(N) — single pass to build `lastIndex`, single pass to emit `out`.
 */
export function dedupeLastWins<T>(
    items: readonly T[],
    keyFn: (item: T) => string,
    onDropped: (item: T) => void,
): T[] {
    if (items.length <= 1) return items.slice();
    const lastIndex = new Map<string, number>();
    items.forEach((item, i) => lastIndex.set(keyFn(item), i));
    const out: T[] = [];
    items.forEach((item, i) => {
        if (lastIndex.get(keyFn(item)) !== i) {
            onDropped(item);
            return;
        }
        out.push(item);
    });
    return out;
}
