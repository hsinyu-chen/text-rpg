import { Injectable, inject } from '@angular/core';
import { BlobListEntry, BlobListOptions, BlobMeta, BlobReadResult, BlobStore } from '../blob-store';
import { GoogleDriveService, DriveFile } from '../../google-drive.service';

const APPDATA_ROOT = 'appDataFolder';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/**
 * BlobStore over Google Drive (appDataFolder). Drive doesn't expose a path
 * model — every operation needs a `fileId`. This adapter translates blob
 * paths to file ids by walking from `appDataFolder` and caching the result
 * (`folderIdByPath`, `fileIdByPath`). Caches are populated on
 * list / write / read / copy and invalidated on remove.
 *
 * `write` / `copy` auto-create missing intermediate folders (`mkdir -p`
 * semantics). `list(prefix)` recurses, returning paths relative to the
 * BlobStore root (matching S3BlobStore's contract).
 *
 * Drive `appProperties` stand in for blob metadata and are round-tripped
 * verbatim by `read` / `list`. `updateFile` with `appProperties = undefined`
 * leaves existing properties intact (Drive's merge semantics) — passing
 * an explicit `null` per-key would clear them.
 *
 * **Known performance issues to address when GDrive is wired up
 * (deferred from PR2):**
 *   - `listRecursive` is `O(N)` API calls for `N` subfolders. The
 *     post-migration tombstone layout (`tombstones/<r>/<id>/<deletedAt>`)
 *     creates one folder per id — listing all tombstones for a resource
 *     becomes `N+1` round-trips. Fix candidates: change GDrive's
 *     tombstone layout to flat (`<id>__<deletedAt>` like File backend), or
 *     batch the lookups via `q='<root>' in parents'` recursion-by-API.
 *   - `resolveFolder` / `resolveFileId` / `write` use `listFiles` +
 *     in-memory `.find` rather than Drive's `q=name='<x>' and '<p>' in parents`
 *     query, which is one round-trip per lookup vs N items returned.
 *     Add `findOneByName(parentId, name)` to GoogleDriveService when this
 *     adapter goes live.
 */
@Injectable({ providedIn: 'root' })
export class GDriveBlobStore implements BlobStore {
    private readonly drive = inject(GoogleDriveService);

    /** path → Drive folder id. Empty path = `appDataFolder`. */
    private folderIdByPath = new Map<string, string>([['', APPDATA_ROOT]]);
    /** path → Drive file id. */
    private fileIdByPath = new Map<string, string>();

    async list(prefix: string, _options?: BlobListOptions): Promise<BlobListEntry[]> {
        // GDrive's `files.list` returns `appProperties` for free, so we
        // honour the BlobListOptions contract by always populating meta.
        // The `_options` arg is accepted for interface parity.
        void _options;
        const cleanPrefix = prefix.replace(/\/+$/, '');
        const folderId = await this.resolveFolder(cleanPrefix, false);
        if (!folderId) return [];
        return this.listRecursive(folderId, cleanPrefix);
    }

    async read(path: string): Promise<BlobReadResult> {
        const fileId = await this.resolveFileId(path);
        if (!fileId) throw new Error(`GDriveBlobStore: ${path} not found`);
        const text = await this.drive.readFile(fileId);
        // TODO (when GDrive is wired up): replace the parent listFiles +
        // .find with a `files.get(fileId, fields=...)` call on
        // GoogleDriveService. One round-trip vs N+1 here. Ditto for
        // `resolveFolder` / `resolveFileId` / `write` (per the doc-block
        // header). Skipped for PR2 because GDriveBlobStore isn't on a
        // hot path yet.
        const { dir, name } = splitPath(path);
        const folderId = await this.resolveFolder(dir, false);
        let meta: BlobMeta = {};
        let etag: string | undefined;
        let modifiedAt = 0;
        let size: number | undefined;
        if (folderId) {
            const files = await this.drive.listFiles(folderId);
            const file = files.find(f => f.name === name);
            if (file) {
                meta = file.appProperties ?? {};
                etag = file.md5Checksum;
                modifiedAt = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;
                size = file.size ? Number(file.size) : undefined;
            }
        }
        return { text, meta, etag, modifiedAt, size };
    }

    async write(path: string, text: string, meta?: BlobMeta): Promise<void> {
        const { dir, name } = splitPath(path);
        const folderId = await this.resolveFolder(dir, true);
        if (!folderId) throw new Error(`GDriveBlobStore: failed to resolve folder for '${path}'`);

        const cached = this.fileIdByPath.get(path);
        if (cached) {
            await this.drive.updateFile(cached, text, meta);
            return;
        }
        // Possible existing-but-uncached file (cold start, first write):
        // listFiles + match by name. Drive allows multiple files with the
        // same name in the same folder; first write per path collapses
        // to update-on-existing.
        const files = await this.drive.listFiles(folderId);
        const existing = files.find(f => f.name === name);
        if (existing) {
            await this.drive.updateFile(existing.id, text, meta);
            this.fileIdByPath.set(path, existing.id);
            return;
        }
        const created = await this.drive.createFile(folderId, name, text, meta);
        this.fileIdByPath.set(path, created.id);
    }

    async remove(path: string): Promise<void> {
        const fileId = await this.resolveFileId(path);
        if (!fileId) return; // already gone
        await this.drive.deleteFile(fileId);
        this.fileIdByPath.delete(path);
    }

    async copy(srcPath: string, dstPath: string): Promise<void> {
        const srcId = await this.resolveFileId(srcPath);
        if (!srcId) throw new Error(`GDriveBlobStore: source '${srcPath}' not found`);
        const { dir: dstDir, name: dstName } = splitPath(dstPath);
        const dstFolderId = await this.resolveFolder(dstDir, true);
        if (!dstFolderId) throw new Error(`GDriveBlobStore: failed to resolve dst folder for '${dstPath}'`);
        const created = await this.drive.copyFile(srcId, dstFolderId, dstName);
        this.fileIdByPath.set(dstPath, created.id);
    }

    async exists(path: string): Promise<boolean> {
        return (await this.resolveFileId(path)) !== null;
    }

    /** Drops every cached id. Call after operations that mutate the
     *  Drive tree behind our back (e.g. external user moves / deletes,
     *  or migrations that bypass this store). */
    invalidateCaches(): void {
        this.folderIdByPath = new Map<string, string>([['', APPDATA_ROOT]]);
        this.fileIdByPath = new Map<string, string>();
    }

    /**
     * Walks `path` (`'/'`-separated) from `appDataFolder` down. With
     * `create=true` missing intermediates are created; with `create=false`
     * a missing intermediate causes a `null` return (caller decides whether
     * that's an error or "absent → empty list").
     */
    private async resolveFolder(path: string, create: boolean): Promise<string | null> {
        const cached = this.folderIdByPath.get(path);
        if (cached) return cached;
        const parts = path.split('/').filter(p => p.length > 0);
        let parentId = APPDATA_ROOT;
        let walked = '';
        for (const part of parts) {
            walked = walked ? `${walked}/${part}` : part;
            const cachedSub = this.folderIdByPath.get(walked);
            if (cachedSub) { parentId = cachedSub; continue; }
            const folders = await this.drive.listFolders(parentId);
            const found = folders.find(f => f.name === part);
            if (found) {
                parentId = found.id;
            } else if (create) {
                const newFolder = await this.drive.createFolder(parentId, part);
                parentId = newFolder.id;
            } else {
                return null;
            }
            this.folderIdByPath.set(walked, parentId);
        }
        return parentId;
    }

    private async resolveFileId(path: string): Promise<string | null> {
        const cached = this.fileIdByPath.get(path);
        if (cached) return cached;
        const { dir, name } = splitPath(path);
        const folderId = await this.resolveFolder(dir, false);
        if (!folderId) return null;
        const files = await this.drive.listFiles(folderId);
        const found = files.find(f => f.name === name);
        if (!found) return null;
        this.fileIdByPath.set(path, found.id);
        return found.id;
    }

    private async listRecursive(folderId: string, pathPrefix: string): Promise<BlobListEntry[]> {
        const out: BlobListEntry[] = [];
        const allItems = await this.drive.listFiles(folderId);
        const fileItems: DriveFile[] = [];
        const folderItems: DriveFile[] = [];
        for (const f of allItems) {
            (f.mimeType === DRIVE_FOLDER_MIME ? folderItems : fileItems).push(f);
        }
        for (const f of fileItems) {
            const entryPath = pathPrefix ? `${pathPrefix}/${f.name}` : f.name;
            this.fileIdByPath.set(entryPath, f.id);
            out.push({
                path: entryPath,
                meta: f.appProperties ?? {},
                etag: f.md5Checksum,
                modifiedAt: f.modifiedTime ? new Date(f.modifiedTime).getTime() : 0,
                size: f.size ? Number(f.size) : undefined
            });
        }
        for (const sub of folderItems) {
            const subPath = pathPrefix ? `${pathPrefix}/${sub.name}` : sub.name;
            this.folderIdByPath.set(subPath, sub.id);
            const subEntries = await this.listRecursive(sub.id, subPath);
            out.push(...subEntries);
        }
        return out;
    }
}

function splitPath(path: string): { dir: string; name: string } {
    const i = path.lastIndexOf('/');
    return i === -1 ? { dir: '', name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}
