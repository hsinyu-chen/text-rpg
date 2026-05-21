import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import type {
    AutoFixLog,
    EntityDelete,
    EntityMove,
    EntityUpdate,
    SaveManifest,
} from '../multi-agent-save.types';
import { extractL2EntriesByGroup } from '../utils/extract-l2-entries.util';

export interface LifecycleCFixResult {
    manifest: SaveManifest;
    fixes: AutoFixLog[];
}

/**
 * Mechanical C-fix for entity lifecycle slots (characters/factions
 * `Create / Delete / Move / Update`).
 * See TextRPG_Plans/doing/multi-agent-save-per-domain-checks.md (Sub-1).
 *
 * Sub-1 scope:
 *
 * 1. **Delete misses KB** — `EntityDelete.sectionPath` resolves to an entity
 *    not present in the target file → drop the op (handler-side no-op anyway,
 *    surfaced here for trace visibility).
 * 2. **Move misses KB** — same for `EntityMove.fromSectionPath`.
 * 3. **Update misses KB (name typo)** — `EntityUpdate.name` not present →
 *    drop the entry.
 * 4. **Delete short-circuits Update** — same entity in both → drop Update;
 *    delete wins. Sub-agent / patch on something about to be deleted is
 *    wasted work.
 * 5. **Delete short-circuits Move** — same entity in both → drop Move; delete
 *    wins. Move-then-delete is degenerate.
 * 6. **Update's SectionUpdate out of scope** — `updates[].sectionPath` doesn't
 *    include `## ${entity.name}` as a segment → drop that SectionUpdate.
 *    Catches the "main LLM patched the wrong entity's block" failure mode.
 *
 * Deferred to later iteration (need cross-domain visibility / body parsing):
 * - L1 group not in KB for `Create` / `Move.toGroup` — auto-emit the L1
 *   heading. Today the handler silently no-ops; C-flag should surface.
 * - Connected plans / inventory cleanup when entity deleted — needs body-text
 *   scan for owner reference.
 *
 * Pure function over the manifest + KB file snapshots.
 */
export function cFixLifecycle(
    manifest: SaveManifest,
    kbFiles: ReadonlyMap<string, string>,
    coreFilenames: AppLocale['coreFilenames'],
): LifecycleCFixResult {
    const fixes: AutoFixLog[] = [];

    const charResult = cleanupSlice({
        kind: 'character',
        kbContent: kbFiles.get(coreFilenames.CHARACTER_STATUS) ?? '',
        deletes: manifest.charactersToDelete ?? [],
        moves: manifest.charactersToMove ?? [],
        updates: manifest.charactersToUpdate ?? [],
    });
    fixes.push(...charResult.fixes);

    const facResult = cleanupSlice({
        kind: 'faction',
        kbContent: kbFiles.get(coreFilenames.WORLD_FACTIONS) ?? '',
        deletes: manifest.factionsToDelete ?? [],
        moves: manifest.factionsToMove ?? [],
        updates: manifest.factionsToUpdate ?? [],
    });
    fixes.push(...facResult.fixes);

    return {
        manifest: {
            ...manifest,
            charactersToDelete: charResult.deletes,
            charactersToMove: charResult.moves,
            charactersToUpdate: charResult.updates,
            factionsToDelete: facResult.deletes,
            factionsToMove: facResult.moves,
            factionsToUpdate: facResult.updates,
        },
        fixes,
    };
}

interface CleanupInput {
    kind: 'character' | 'faction';
    kbContent: string;
    deletes: readonly EntityDelete[];
    moves: readonly EntityMove[];
    updates: readonly EntityUpdate[];
}

interface CleanupResult {
    deletes: EntityDelete[];
    moves: EntityMove[];
    updates: EntityUpdate[];
    fixes: AutoFixLog[];
}

function cleanupSlice(input: CleanupInput): CleanupResult {
    const fixes: AutoFixLog[] = [];
    const entityNames = new Set(
        extractL2EntriesByGroup(input.kbContent).map(e => e.name),
    );

    // Step 1: filter deletes — drop those whose target entity doesn't exist
    // in the KB. Collect surviving deletes' entity names so we can short-
    // circuit downstream Move / Update for the same entity (delete wins).
    const deletedNames = new Set<string>();
    const deletes: EntityDelete[] = [];
    for (const d of input.deletes) {
        const name = entityNameFromSectionPath(d.sectionPath);
        if (!name) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'dropped-malformed-delete-path',
                reason: `${input.kind}sToDelete — unparseable sectionPath: "${d.sectionPath}"`,
            });
            continue;
        }
        if (!entityExists(entityNames, name)) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'dropped-missing-delete',
                reason: `${input.kind}sToDelete — "${name}" not found in KB`,
            });
            continue;
        }
        deletedNames.add(name);
        deletes.push(d);
    }

    // Step 2: filter moves — drop those whose source entity doesn't resolve,
    // OR whose entity is already being deleted (delete wins).
    const moves: EntityMove[] = [];
    for (const m of input.moves) {
        const name = entityNameFromSectionPath(m.fromSectionPath);
        if (!name) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'dropped-malformed-move-path',
                reason: `${input.kind}sToMove — unparseable fromSectionPath: "${m.fromSectionPath}"`,
            });
            continue;
        }
        if (deletedNames.has(name)) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'shortcircuit-move-by-delete',
                reason: `${input.kind}sToMove — "${name}" dropped (delete wins)`,
            });
            continue;
        }
        if (!entityExists(entityNames, name)) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'dropped-missing-move',
                reason: `${input.kind}sToMove — "${name}" not found in KB`,
            });
            continue;
        }
        moves.push(m);
    }

    // Step 3: filter updates — drop typo'd entities, drop entities also in
    // deletedNames, filter SectionUpdate items by scope.
    const updates: EntityUpdate[] = [];
    for (const u of input.updates) {
        if (!u.name) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'dropped-empty-update-name',
                reason: `${input.kind}sToUpdate — entry with empty name`,
            });
            continue;
        }
        if (deletedNames.has(u.name)) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'shortcircuit-update-by-delete',
                reason: `${input.kind}sToUpdate — "${u.name}" dropped (delete wins)`,
            });
            continue;
        }
        if (!entityExists(entityNames, u.name)) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'dropped-update-name-typo',
                reason: `${input.kind}sToUpdate — "${u.name}" not found in KB`,
            });
            continue;
        }

        if (!u.updates || u.updates.length === 0) {
            // Bare entry — reserved for multi-call sub-agent. Pass through.
            updates.push(u);
            continue;
        }

        const scopedUpdates = u.updates.filter(su => {
            if (!sectionPathScopedToEntity(su.sectionPath, u.name)) {
                fixes.push({
                    domain: 'lifecycle',
                    kind: 'dropped-section-out-of-scope',
                    reason: `${input.kind}sToUpdate — "${u.name}": SectionUpdate sectionPath "${su.sectionPath}" not scoped to entity`,
                });
                return false;
            }
            return true;
        });

        if (scopedUpdates.length === 0) {
            // Every SectionUpdate was out-of-scope; nothing useful remains.
            // The drop reasons above already explain why; no separate fix.
            continue;
        }
        updates.push({ ...u, updates: scopedUpdates });
    }

    return { deletes, moves, updates, fixes };
}

/**
 * Extract the L2 entity name from a breadcrumb-style sectionPath. Supports
 * the canonical `# L1 > ## L2` form the manifest schema documents; also
 * tolerates a bare `## L2` (some local models emit just the leaf).
 *
 * Returns `''` when no `## L2` segment is found — caller drops the op.
 */
function entityNameFromSectionPath(sectionPath: string): string {
    if (!sectionPath) return '';
    // Find the LAST `## X` segment. The breadcrumb separator is ` > ` but
    // models drift; split on the actual ATX marker is more robust.
    const segments = sectionPath.split(/\s*>\s*/);
    for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i].trim();
        const match = seg.match(/^##\s+(.+)$/);
        if (match) return match[1].trim();
    }
    return '';
}

/**
 * True when the KB has an L2 heading whose text equals or starts with
 * `${name}` followed by a non-word boundary. The boundary-aware match is what
 * lets `"李四"` match the KB heading `"李四 (Li Si)"` without false-matching
 * `"李四五"`. Pure substring would do the latter; equality would miss the
 * former.
 */
function entityExists(entityNames: ReadonlySet<string>, name: string): boolean {
    if (entityNames.has(name)) return true;
    // Alias-tolerant: KB heading might be `"${name} (Latin)"` or `"${name}（latin）"`.
    for (const known of entityNames) {
        if (known === name) return true;
        if (known.startsWith(name)) {
            const next = known.charAt(name.length);
            // Boundary chars common in aliased headings.
            if (next === ' ' || next === '(' || next === '（') return true;
        }
    }
    return false;
}

/**
 * Loose scoping check: does `sectionPath` contain a `## ${entityName}`
 * segment? The manifest schema requires entity SectionUpdates to start at the
 * entity's L2 path (`# 核心人物 > ## 李四 ...`), so the check catches the
 * common LLM mistake of patching another entity's block.
 *
 * Boundary-aware like {@link entityExists} so `"李四"` matches `"## 李四 (Li
 * Si)"` segments. Tolerates deeper L3+ paths under the entity.
 */
function sectionPathScopedToEntity(sectionPath: string, entityName: string): boolean {
    if (!sectionPath || !entityName) return false;
    const segments = sectionPath.split(/\s*>\s*/);
    for (const segRaw of segments) {
        const seg = segRaw.trim();
        const m = seg.match(/^##\s+(.+)$/);
        if (!m) continue;
        const segName = m[1].trim();
        if (segName === entityName) return true;
        if (segName.startsWith(entityName)) {
            const next = segName.charAt(entityName.length);
            if (next === ' ' || next === '(' || next === '（') return true;
        }
    }
    return false;
}
