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
