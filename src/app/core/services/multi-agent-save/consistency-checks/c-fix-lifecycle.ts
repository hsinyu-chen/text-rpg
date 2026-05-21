import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import type {
    AutoFixLog,
    EntityDelete,
    EntityMove,
    EntityUpdate,
    SaveManifest,
    SectionUpdate,
} from '../multi-agent-save.types';
import { extractL2EntriesByGroup } from '../utils/extract-l2-entries.util';
import { dedupeLastWins } from '../utils/handler-helpers.util';

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
 *    not present in the target file → drop the op.
 * 2. **Move misses KB** — same for `EntityMove.fromSectionPath`.
 * 3. **Update misses KB (name typo)** — `EntityUpdate.name` not present → drop.
 * 4. **Delete short-circuits Update** — same entity in both → drop Update.
 * 5. **Delete short-circuits Move** — same entity in both → drop Move.
 * 6. **Update's SectionUpdate out of scope** — `updates[].sectionPath` doesn't
 *    include `## ${entity.name}` as a segment → drop that SectionUpdate.
 * 7. **Canonicalize aliased entity names** — when the LLM emits a bare name
 *    (`李四`) but the KB heading is aliased (`李四 (Li Si)`) or vice versa,
 *    rewrite the manifest entry's sectionPath / name / nested
 *    updates[].sectionPath to the KB-canonical form so the downstream
 *    mechanical handler (which uses strict-equality lookups) actually finds
 *    the section.
 *
 * Deferred to later iteration:
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

interface PathOpLabels {
    /** Manifest field name for trace, e.g. `charactersToDelete`. */
    label: string;
    /** Field on the op that holds the path, e.g. `sectionPath` or `fromSectionPath`. */
    pathField: string;
    /** AutoFix kind emitted when the path can't be parsed. */
    malformedKind: string;
    /** AutoFix kind emitted when the parsed name doesn't resolve to a KB heading. */
    missingKind: string;
}

interface ResolvedOpPath {
    /** KB-canonical L2 name; safe to compare across alias variants. */
    canonical: string;
    /** sectionPath with the L2 segment rewritten to `## ${canonical}` if changed. */
    rewrittenPath: string;
    /** True when `rewrittenPath !== originalPath`. */
    didRewrite: boolean;
}

function cleanupSlice(input: CleanupInput): CleanupResult {
    const fixes: AutoFixLog[] = [];
    const entityNames = new Set(
        extractL2EntriesByGroup(input.kbContent).map(e => e.name),
    );

    // Step 1: filter deletes — drop those whose target entity doesn't exist
    // in the KB. Collect surviving deletes' CANONICAL (KB-known) names so
    // short-circuit checks in steps 2/3 compare apples to apples even when
    // the LLM mixes bare names with aliased headings (`李四` vs `李四 (Li
    // Si)`). Also rewrite each surviving op's sectionPath to the canonical
    // form so the downstream handler's strict-equality lookup hits.
    //
    // Dedupe by canonical, keep last — two deletes for the same entity would
    // both anchor to the same KB block; downstream handler emits two delete
    // hunks targeting the same lines, the second fails on apply.
    const deletedCanonical = dedupeOpsByCanonical(
        input.deletes,
        d => resolveOpPath(d.sectionPath, entityNames, {
            label: `${input.kind}sToDelete`,
            pathField: 'sectionPath',
            malformedKind: 'dropped-malformed-delete-path',
            missingKind: 'dropped-missing-delete',
        }, fixes),
        (d, resolved) => applyPathRewrite(d, 'sectionPath', resolved, fixes,
            `${input.kind}sToDelete`),
        fixes,
        {
            opLabel: `${input.kind}sToDelete`,
            dupKind: 'dropped-stale-dup-delete',
        },
    );
    const deletes = deletedCanonical.entries;
    const deletedNames = deletedCanonical.canonicalSet;

    // Step 2: filter moves — drop those whose source entity doesn't resolve,
    // OR whose entity is already being deleted (delete wins). Also dedupe
    // surviving moves by canonical — two moves for the same entity to
    // different toGroups would otherwise duplicate the block across both
    // groups (delete anchors collide, but each append still fires).
    const moveResolution = dedupeOpsByCanonical(
        input.moves,
        m => {
            const r = resolveOpPath(m.fromSectionPath, entityNames, {
                label: `${input.kind}sToMove`,
                pathField: 'fromSectionPath',
                malformedKind: 'dropped-malformed-move-path',
                missingKind: 'dropped-missing-move',
            }, fixes);
            if (!r) return null;
            if (deletedNames.has(r.canonical)) {
                fixes.push({
                    domain: 'lifecycle',
                    kind: 'shortcircuit-move-by-delete',
                    reason: `${input.kind}sToMove — "${r.canonical}" dropped (delete wins)`,
                });
                return null;
            }
            return r;
        },
        (m, resolved) => applyPathRewrite(m, 'fromSectionPath', resolved, fixes,
            `${input.kind}sToMove`),
        fixes,
        {
            opLabel: `${input.kind}sToMove`,
            dupKind: 'dropped-stale-dup-move',
        },
    );
    const moves = moveResolution.entries;

    // Step 3: filter updates — drop typo'd entities, drop entities also in
    // deletedCanonical, filter SectionUpdate items by scope. Rewrite name +
    // nested updates[].sectionPath to canonical when the LLM used a different
    // alias form.
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
        const canonical = resolveEntityName(entityNames, u.name);
        if (!canonical) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'dropped-update-name-typo',
                reason: `${input.kind}sToUpdate — "${u.name}" not found in KB`,
            });
            continue;
        }
        if (deletedNames.has(canonical)) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'shortcircuit-update-by-delete',
                reason: `${input.kind}sToUpdate — "${u.name}" dropped (delete wins)`,
            });
            continue;
        }

        const nameRewritten = canonical !== u.name;
        if (nameRewritten) {
            fixes.push({
                domain: 'lifecycle',
                kind: 'canonicalized-update-name',
                reason: `${input.kind}sToUpdate — "${u.name}" rewritten to KB-canonical "${canonical}"`,
            });
        }

        if (!u.updates || u.updates.length === 0) {
            // Bare entry — reserved for multi-call sub-agent. Pass through
            // with canonical name so downstream consumers see the resolved form.
            updates.push(nameRewritten ? { ...u, name: canonical } : u);
            continue;
        }

        const scopedUpdates: SectionUpdate[] = [];
        for (const su of u.updates) {
            if (!sectionPathScopedToEntity(su.sectionPath, canonical)) {
                fixes.push({
                    domain: 'lifecycle',
                    kind: 'dropped-section-out-of-scope',
                    reason: `${input.kind}sToUpdate — "${canonical}": SectionUpdate sectionPath "${su.sectionPath}" not scoped to entity`,
                });
                continue;
            }
            // Rewrite the L2 segment to canonical for handler strict-lookup.
            const newPath = rewriteSectionPathL2ToEntity(su.sectionPath, canonical);
            scopedUpdates.push(newPath === su.sectionPath ? su : { ...su, sectionPath: newPath });
        }

        if (scopedUpdates.length === 0) {
            // Every SectionUpdate was out-of-scope; nothing useful remains.
            continue;
        }
        updates.push({
            ...u,
            ...(nameRewritten ? { name: canonical } : {}),
            updates: scopedUpdates,
        });
    }

    // Step 4: merge EntityUpdate entries that landed on the same canonical
    // name. Same anchor-conflict failure mode as delete/move: two entries
    // for "李四" with overlapping sectionPaths would emit two replace hunks
    // anchored to the same KB block, second fails on apply. Concatenate
    // their .updates lists so the downstream `applyEntityUpdatesDedup`
    // (within one entry) catches the same-sectionPath case in one place.
    const mergedUpdates = mergeUpdatesByCanonicalName(updates, fixes, input.kind);

    return { deletes, moves, updates: mergedUpdates, fixes };
}

/**
 * Group `updates` by `.name` (already canonical) and concatenate each group's
 * `.updates` payloads into the first occurrence. Same-sectionPath collisions
 * inside the merged list are caught later by `cFixSectionUpdates` (called
 * per entry by `c-fix-runner`). Emits one `merged-duplicate-update-entry`
 * fix log per merge so the trace explains why the entry-count shrank.
 *
 * Bare entries (no `.updates`) merge cleanly: their undefined `.updates`
 * contributes nothing to the concatenation. The non-bare entry's metadata
 * wins for `reasonHint` when both carry one (last-occurrence preference,
 * matching the dedupe-last-wins convention used elsewhere in this module).
 */
function mergeUpdatesByCanonicalName(
    updates: EntityUpdate[],
    fixes: AutoFixLog[],
    kind: string,
): EntityUpdate[] {
    if (updates.length <= 1) return updates;
    const indexByName = new Map<string, number>();
    const merged: EntityUpdate[] = [];
    for (const u of updates) {
        const prevIdx = indexByName.get(u.name);
        if (prevIdx === undefined) {
            indexByName.set(u.name, merged.length);
            merged.push(u);
            continue;
        }
        const prev = merged[prevIdx];
        const combined = [...(prev.updates ?? []), ...(u.updates ?? [])];
        merged[prevIdx] = {
            ...prev,
            ...(u.reasonHint !== undefined ? { reasonHint: u.reasonHint } : {}),
            ...(combined.length > 0 ? { updates: combined } : {}),
        };
        fixes.push({
            domain: 'lifecycle',
            kind: 'merged-duplicate-update-entry',
            reason: `${kind}sToUpdate — "${u.name}": merged duplicate entry's updates into earlier entry (handler would otherwise anchor-conflict on overlapping sectionPaths)`,
        });
    }
    return merged;
}

/**
 * Resolve every op via `resolve` (which logs malformed / missing / short-
 * circuit fixes as it goes), then dedupe surviving ops by canonical name
 * keeping the last occurrence. Earlier dups get a `dupKind` fix log so the
 * trace explains why the manifest dropped them.
 *
 * Shared by delete + move loops — the anchor-conflict failure mode
 * (downstream handler emits two hunks targeting the same KB block, second
 * fails on apply) applies identically to both, so the dedup strategy
 * (last-wins) is identical too. `resolve` carries the op-specific path
 * extraction + short-circuit logic; `rewrite` produces the canonical-
 * rewritten op shape returned to the caller.
 */
function dedupeOpsByCanonical<TOp, TResolved extends { canonical: string }>(
    ops: readonly TOp[],
    resolve: (op: TOp) => TResolved | null,
    rewrite: (op: TOp, resolved: TResolved) => TOp,
    fixes: AutoFixLog[],
    labels: { opLabel: string; dupKind: string },
): { entries: TOp[]; canonicalSet: Set<string> } {
    const resolved: { op: TOp; resolved: TResolved }[] = [];
    for (const op of ops) {
        const r = resolve(op);
        if (r) resolved.push({ op, resolved: r });
    }
    const surviving = dedupeLastWins(
        resolved,
        r => r.resolved.canonical,
        r => fixes.push({
            domain: 'lifecycle',
            kind: labels.dupKind,
            reason: `${labels.opLabel} — "${r.resolved.canonical}": dropped (later op on same entity supersedes; handler would otherwise anchor-conflict)`,
        }),
    );
    const entries = surviving.map(r => rewrite(r.op, r.resolved));
    const canonicalSet = new Set(surviving.map(r => r.resolved.canonical));
    return { entries, canonicalSet };
}

/**
 * Parse + KB-resolve the entity at the head of an op's sectionPath. Returns
 * `null` (logging a fix) when the path is malformed or names an entity not in
 * the KB; otherwise returns the canonical name and the (possibly rewritten)
 * sectionPath. Shared by delete + move loops to avoid duplicating the
 * parse / resolve / fix-log triplet.
 */
function resolveOpPath(
    sectionPath: string,
    entityNames: ReadonlySet<string>,
    labels: PathOpLabels,
    fixes: AutoFixLog[],
): ResolvedOpPath | null {
    const rawName = entityNameFromSectionPath(sectionPath);
    if (!rawName) {
        fixes.push({
            domain: 'lifecycle',
            kind: labels.malformedKind,
            reason: `${labels.label} — unparseable ${labels.pathField}: "${sectionPath}"`,
        });
        return null;
    }
    const canonical = resolveEntityName(entityNames, rawName);
    if (!canonical) {
        fixes.push({
            domain: 'lifecycle',
            kind: labels.missingKind,
            reason: `${labels.label} — "${rawName}" not found in KB`,
        });
        return null;
    }
    const rewrittenPath = canonical === rawName
        ? sectionPath
        : rewriteSectionPathL2(sectionPath, canonical);
    return {
        canonical,
        rewrittenPath,
        didRewrite: rewrittenPath !== sectionPath,
    };
}

/**
 * Returns either the original op (no rewrite needed) or a shallow clone with
 * the named path field replaced by the canonical-rewritten path. Emits one
 * `canonicalized-op-path` fix log per rewrite so the trace explains why the
 * applied manifest differs from the LLM's.
 *
 * Generic over (op type T, field name F) so a single helper serves both
 * call sites — `EntityDelete + 'sectionPath'` and `EntityMove +
 * 'fromSectionPath'` — without forcing a union return type. The
 * `Record<F, string>` constraint says "T must carry the named string field"
 * and is satisfied by both EntityDelete (has sectionPath) and EntityMove
 * (has fromSectionPath) at their respective call sites.
 */
function applyPathRewrite<F extends string, T extends Record<F, string>>(
    op: T,
    pathField: F,
    resolved: ResolvedOpPath,
    fixes: AutoFixLog[],
    label: string,
): T {
    if (!resolved.didRewrite) return op;
    fixes.push({
        domain: 'lifecycle',
        kind: 'canonicalized-op-path',
        reason: `${label} — "${op[pathField]}" rewritten to canonical "${resolved.rewrittenPath}"`,
    });
    return { ...op, [pathField]: resolved.rewrittenPath };
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
    const segments = sectionPath.split(/\s*>\s*/);
    for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i].trim();
        const match = seg.match(/^##\s+(.+)$/);
        if (match) return match[1].trim();
    }
    return '';
}

/**
 * Rewrite the last `## X` segment of `sectionPath` to `## ${canonical}`,
 * leaving L1+ ancestors and any deeper L3+ trailing segments untouched.
 * Used to swap a model-emitted bare name for the KB-known aliased form (or
 * vice versa) so downstream strict-equality lookups succeed.
 */
function rewriteSectionPathL2(sectionPath: string, canonical: string): string {
    const segments = sectionPath.split(/\s*>\s*/);
    for (let i = segments.length - 1; i >= 0; i--) {
        if (/^##\s+/.test(segments[i].trim())) {
            segments[i] = `## ${canonical}`;
            return segments.join(' > ');
        }
    }
    return sectionPath;
}

/**
 * Like {@link rewriteSectionPathL2} but locates the L2 segment that matches
 * the given canonical entity (alias-tolerant) anywhere in the breadcrumb,
 * not necessarily the last one. Used for nested `EntityUpdate.updates[]`
 * paths where a deeper L3+ segment may follow the entity heading
 * (`# 核心人物 > ## 李四 > ### 心態`). Returns the original path unchanged
 * when the entity segment already matches canonical.
 */
function rewriteSectionPathL2ToEntity(sectionPath: string, canonical: string): string {
    const segments = sectionPath.split(/\s*>\s*/);
    let changed = false;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i].trim();
        const m = seg.match(/^##\s+(.+)$/);
        if (!m) continue;
        const segName = m[1].trim();
        if (segName === canonical) return sectionPath;
        if (isAliasOrExact(segName, canonical)) {
            segments[i] = `## ${canonical}`;
            changed = true;
            break;
        }
    }
    return changed ? segments.join(' > ') : sectionPath;
}

/**
 * Boundary-aware alias match: returns true when `a` and `b` are equal, OR
 * one is a prefix of the other followed by a heading-alias boundary char
 * (` `, `(`, `（`). Lets `"李四"` and `"李四 (Li Si)"` match in both
 * directions without false-matching `"李四五"`.
 *
 * Symmetric so both `resolveEntityName` (KB heading may have or lack the
 * alias) and `sectionPathScopedToEntity` (manifest sectionPath segment may
 * have or lack the alias) get the same answer regardless of which side
 * carries the longer form.
 */
function isAliasOrExact(a: string, b: string): boolean {
    if (a === b) return true;
    const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
    if (!longer.startsWith(shorter)) return false;
    const next = longer.charAt(shorter.length);
    return next === ' ' || next === '(' || next === '（';
}

/**
 * Returns the canonical KB-known L2 heading text that matches `name` (exact
 * or alias-tolerant), or `null` when no match exists.
 *
 * The canonical-string return is what lets the caller compare delete /
 * move / update sets safely under aliasing: storing the canonical name in
 * `deletedCanonical` means a later `deletedCanonical.has(canonical)` check
 * on a different alias-form input still hits — they both resolve to the
 * same KB heading.
 */
function resolveEntityName(entityNames: ReadonlySet<string>, name: string): string | null {
    if (entityNames.has(name)) return name;
    for (const known of entityNames) {
        if (isAliasOrExact(known, name)) return known;
    }
    return null;
}

/**
 * Loose scoping check: does `sectionPath` contain a `## ${entityName}`
 * segment? The manifest schema requires entity SectionUpdates to start at the
 * entity's L2 path (`# 核心人物 > ## 李四 ...`), so the check catches the
 * common LLM mistake of patching another entity's block.
 *
 * Boundary-aware via {@link isAliasOrExact} so `"李四"` matches `"## 李四 (Li
 * Si)"` segments. Tolerates deeper L3+ paths under the entity.
 */
function sectionPathScopedToEntity(sectionPath: string, entityName: string): boolean {
    if (!sectionPath || !entityName) return false;
    const segments = sectionPath.split(/\s*>\s*/);
    for (const segRaw of segments) {
        const seg = segRaw.trim();
        const m = seg.match(/^##\s+(.+)$/);
        if (!m) continue;
        if (isAliasOrExact(m[1].trim(), entityName)) return true;
    }
    return false;
}
