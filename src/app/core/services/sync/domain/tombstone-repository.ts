import { BlobMeta, BlobStore } from '../blob-store';
import { SyncResource, Tombstone } from '../sync.types';
import { TOMBSTONE_DIR, tombstoneDirPrefix, tombstonePath } from '../layout/sync-paths';

/**
 * Encodes how a tombstone (resource + id + deletedAt) is laid out as a
 * BlobStore path. Backends wire the layout that matches their storage
 * shape — S3 + post-migration GDrive use {@link SLASH_TOMBSTONE_LAYOUT}
 * (deletedAt as a path segment), File keeps its filename-encoded form
 * via {@link UNDERSCORE_FILE_TOMBSTONE_LAYOUT}.
 *
 * `parseRelative` receives the path relative to `listPrefix(r)` plus the
 * blob's meta — pre-migration GDrive carried deletedAt in metadata, so a
 * GDrive-specific layout (during the migration window) reads from there.
 */
export interface TombstoneLayout {
    pathFor(r: SyncResource, id: string, deletedAt: number): string;
    listPrefix(r: SyncResource): string;
    /**
     * The narrowest prefix that still encloses every tombstone for the
     * given id. For nested layouts (slash) this is `<listPrefix><id>/` —
     * `removeById` can list a single id's files cheaply. For flat layouts
     * (underscore) the prefix can't be narrowed per id, so this returns
     * the same value as `listPrefix`; `removeById` then filters in-memory.
     */
    idPrefix(r: SyncResource, id: string): string;
    parseRelative(rel: string, meta: BlobMeta): { id: string; deletedAt: number } | null;
}

/** S3 + post-migration GDrive: `tombstones/<r>/<id>/<deletedAt>` */
export const SLASH_TOMBSTONE_LAYOUT: TombstoneLayout = {
    pathFor: (r, id, ts) => tombstonePath(r, id, ts),
    listPrefix: (r) => tombstoneDirPrefix(r),
    idPrefix: (r, id) => `${tombstoneDirPrefix(r)}${id}/`,
    parseRelative: (rel) => {
        const slash = rel.lastIndexOf('/');
        if (slash <= 0) return null; // malformed; skip
        const id = rel.slice(0, slash);
        const tsPart = rel.slice(slash + 1);
        // tsPart length check guards against `<id>/` (trailing slash) →
        // `Number('')` is 0, which would silently parse as deletedAt=0.
        if (!id || tsPart.length === 0) return null;
        const ts = Number(tsPart);
        return Number.isFinite(ts) ? { id, deletedAt: ts } : null;
    }
};

/** File backend: `tombstones/<r>/<id>__<deletedAt>.json` (existing layout, no migration) */
export const UNDERSCORE_FILE_TOMBSTONE_LAYOUT: TombstoneLayout = {
    pathFor: (r, id, ts) => `${TOMBSTONE_DIR[r]}/${id}__${ts}.json`,
    listPrefix: (r) => `${TOMBSTONE_DIR[r]}/`,
    // Flat layout — can't narrow per id. removeById falls back to filter.
    idPrefix: (r) => `${TOMBSTONE_DIR[r]}/`,
    parseRelative: (rel) => {
        const m = /^(.+)__(\d+)\.json$/.exec(rel);
        return m ? { id: m[1], deletedAt: Number(m[2]) } : null;
    }
};

/**
 * Cross-device tombstone storage on top of a {@link BlobStore}. Provides:
 *   - `write(r, id, deletedAt)` — appends a tombstone marker
 *   - `list(r)` — aggregated by id, max deletedAt wins (covers
 *     delete → restore → re-delete on different devices producing
 *     multiple keys for the same id)
 *   - `clear(r)` — wipe all tombstones for a resource (used by forcePush)
 *   - `remove(r, id)` — wipe one id's tombstones (used by snapshot restore
 *     diff-delete, NOT by reconciler)
 */
export class TombstoneRepository {
    constructor(
        private readonly blob: BlobStore,
        private readonly layout: TombstoneLayout
    ) {}

    write(r: SyncResource, id: string, deletedAt: number): Promise<void> {
        return this.blob.write(this.layout.pathFor(r, id, deletedAt), '');
    }

    async list(r: SyncResource): Promise<Tombstone[]> {
        const prefix = this.layout.listPrefix(r);
        // Tombstone deletedAt lives in the path (slash layout) or filename
        // (underscore layout) for the current LayoutS — meta is irrelevant,
        // so skip the per-object meta fetch on backends that would otherwise
        // do one (S3: N HeadObjects; File: N sidecar reads).
        const entries = await this.blob.list(prefix, { withMeta: false });
        const latest = new Map<string, number>();
        for (const e of entries) {
            const rel = e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path;
            const parsed = this.layout.parseRelative(rel, e.meta);
            if (!parsed) continue;
            const prev = latest.get(parsed.id);
            if (prev === undefined || parsed.deletedAt > prev) latest.set(parsed.id, parsed.deletedAt);
        }
        return Array.from(latest, ([id, deletedAt]) => ({ id, deletedAt }));
    }

    async clear(r: SyncResource): Promise<void> {
        const prefix = this.layout.listPrefix(r);
        const entries = await this.blob.list(prefix, { withMeta: false });
        // Sequential delete: AWS DeleteObjects multi isn't universally
        // supported on S3-compatible servers, and the tombstone count
        // here is small (one per ever-deleted entity).
        for (const e of entries) {
            await this.blob.remove(e.path);
        }
    }

    /**
     * Removes every tombstone for a single id. Used by snapshot restore's
     * diff-delete phase (which already determined the id should not be
     * tombstoned in the restored state). Doesn't touch other ids.
     *
     * Uses `layout.idPrefix(r, id)` so nested layouts (slash) list a
     * single id's files instead of every tombstone in the resource. Flat
     * layouts (underscore) get the same prefix as `listPrefix` and the
     * inner `parseRelative` filter narrows per id.
     */
    async removeById(r: SyncResource, id: string): Promise<void> {
        const prefix = this.layout.idPrefix(r, id);
        // Always falls back to the resource-level listPrefix when computing
        // the relative path so `parseRelative` sees the same layout-relative
        // string regardless of how narrow `idPrefix` is.
        const listRoot = this.layout.listPrefix(r);
        const entries = await this.blob.list(prefix, { withMeta: false });
        for (const e of entries) {
            const rel = e.path.startsWith(listRoot) ? e.path.slice(listRoot.length) : e.path;
            const parsed = this.layout.parseRelative(rel, e.meta);
            if (parsed?.id === id) await this.blob.remove(e.path);
        }
    }
}
