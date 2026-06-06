import { LOCALES } from '../../constants/locales';
import { ChatMessage } from '../../models/types';
import { StatChange } from '../../models/stats.types';

/**
 * A Book opts into the numeric-stats system by shipping the stats ledger file.
 * The filename is locale-specific (`optionalFilenames.STATS_YAML`), so a Book
 * authored in either locale must be recognised — hence the scan across all
 * LOCALES rather than the active one.
 */
export function hasStatsYamlFile(files: ReadonlyMap<string, string>): boolean {
    return Object.values(LOCALES).some(l => files.has(l.optionalFilenames.STATS_YAML));
}

/**
 * The raw stats ledger content for whichever locale's filename is present, or
 * `null` if no Book opted in. Same all-locale scan as {@link hasStatsYamlFile}
 * so the two never disagree about which file is the stats file.
 */
export function getStatsYamlContent(files: ReadonlyMap<string, string>): string | null {
    for (const l of Object.values(LOCALES)) {
        const content = files.get(l.optionalFilenames.STATS_YAML);
        if (content !== undefined) return content;
    }
    return null;
}

/**
 * The authoritative numeric-stat fold basis: the `stat_delta` of every active
 * model message, as per-message lists in chronological order. The resolver's
 * pre-turn fold and the two-call seam's fold MUST share this exact message set,
 * else resolver-current and narrator-current values diverge for the player.
 *
 * Active-timeline membership is `role === 'model' && !isRefOnly` — the same
 * predicate the rest of the engine uses. `isManualRefOnly` is metadata for
 * whether the user toggled the flag by hand; a message toggled ref-only then
 * back to active keeps that flag with `isRefOnly: false`, so it must still count.
 */
export function priorStatDeltaLists(messages: ChatMessage[]): StatChange[][] {
    return messages
        .filter(m => m.role === 'model' && !m.isRefOnly)
        .map(m => m.stat_delta ?? []);
}
