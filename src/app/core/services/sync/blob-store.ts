/**
 * Path-addressed text blob IO. Each backend (S3 / GDrive / File) implements
 * this on top of its native model:
 *
 *   - S3:    `path` → `<config-prefix><path>` object key. Native server-side copy.
 *   - GDrive: `path` → file id via internal `path ↔ fileId` cache (populated
 *     on list / write / copy / remove). Native server-side copy.
 *   - File (FSA): `path` → walked from root via getDirectoryHandle/getFileHandle.
 *     Copy emulated as read+write.
 *
 * Path shape constraints:
 *   - `'/'`-separated, no leading `'/'`, no `'..'`
 *   - Caller is responsible for stable layout (see `layout/sync-paths.ts`)
 *
 * `BlobMeta` is a flat string KV that backends round-trip with the blob
 * (S3: object metadata; GDrive: appProperties; File: sidecar). Backends
 * may prefix internal keys; caller-supplied keys must be stable across
 * versions and devices.
 *
 * Domain-level concerns (resource path layout, tombstone keys, last-active
 * metadata names) live in `layout/sync-paths.ts` + `domain/*-repository.ts`,
 * NOT here.
 */

export type BlobMeta = Record<string, string>;

export interface BlobReadResult {
    text: string;
    meta: BlobMeta;
    /** ETag if backend reports one cheaply (S3 / GDrive yes; File no). */
    etag?: string;
    /** Server-side last-modified, wall-clock ms. UI / file-viewer only;
     *  never used for sync decisions. */
    modifiedAt: number;
    size?: number;
}

export interface BlobListEntry {
    /** Path relative to the BlobStore's root, no leading `'/'`. */
    path: string;
    meta: BlobMeta;
    etag?: string;
    modifiedAt: number;
    size?: number;
}

export interface BlobListOptions {
    /**
     * When `false`, `list` returns entries with empty `meta` and skips
     * any per-object metadata fetch the backend would otherwise do
     * (S3: N HeadObject requests; File: N sidecar reads; GDrive: no-op
     * since `appProperties` come for free on `files.list`).
     *
     * Use for layouts where the meta isn't part of the contract — e.g.
     * tombstones encode `deletedAt` in the path. Default: `true`.
     */
    withMeta?: boolean;
}

export interface BlobStore {
    /** Recursive list under `prefix`. May return [] if prefix doesn't exist. */
    list(prefix: string, options?: BlobListOptions): Promise<BlobListEntry[]>;
    /**
     * Names of immediate subfolders directly under `prefix`. Used by
     * callers that need to enumerate top-level partitioning (e.g.
     * `snapshots/` → list of snapshot ids) without walking each
     * subfolder's contents — an `O(1)` round-trip on GDrive vs the
     * `O(N)` cost of a recursive `list()` followed by a filter.
     *
     * Returns folder names (not paths). The empty array if `prefix`
     * doesn't exist.
     */
    listFolders(prefix: string): Promise<string[]>;
    /**
     * Reads a blob; throws if missing. Use {@link exists} first if
     * absence is a normal outcome.
     */
    read(path: string): Promise<BlobReadResult>;
    /**
     * Writes text + meta; creates intermediate folders. Backends round-trip
     * meta verbatim — caller is responsible for choosing keys that survive
     * backend constraints (e.g. S3 metadata keys are case-folded by HTTP).
     */
    write(path: string, text: string, meta?: BlobMeta): Promise<void>;
    remove(path: string): Promise<void>;
    /**
     * Removes the folder at `path` and everything under it. On backends
     * with native recursive folder delete (GDrive, FSA), this is one
     * operation; on S3 — which has no folder concept — the implementation
     * walks `list(path)` and removes each object. Cleans up empty folder
     * shells that bare `remove()` per-file would otherwise leave behind.
     */
    removeFolder(path: string): Promise<void>;
    /**
     * Server-side copy where supported (S3 CopyObject, GDrive files.copy);
     * read+write fallback for File. Meta is preserved end-to-end.
     */
    copy(srcPath: string, dstPath: string): Promise<void>;
    exists(path: string): Promise<boolean>;
}
