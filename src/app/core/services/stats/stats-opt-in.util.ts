import { LOCALES } from '../../constants/locales';

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
