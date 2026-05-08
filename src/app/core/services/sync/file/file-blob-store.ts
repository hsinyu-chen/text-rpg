import { Injectable, inject } from '@angular/core';
import { BlobListEntry, BlobListOptions, BlobMeta, BlobReadResult, BlobStore } from '../blob-store';
import { FileBackendPermissionService } from './file-backend-permission.service';
import { ensureDir, getDirIfExists, isNotFound, splitDir } from '../fsa-utils';
import { createParallelPool } from '@app/core/utils/async.util';
import { SNAPSHOT_CONCURRENCY } from '../sync-snapshot-utils';

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);

const META_SUFFIX = '.meta.json';

/**
 * BlobStore over File System Access (FSA). FSA has no native per-file
 * metadata; to honour the BlobStore contract that `meta` round-trips,
 * we store the meta as a sidecar JSON file next to the body:
 *
 *   `books/abc.json`           ← body
 *   `books/abc.json.meta.json` ← meta sidecar (omitted if meta is empty)
 *
 * The sidecar suffix is `*.meta.json` (not `*.meta`) so editors that
 * hide non-`.json` files don't make sidecars invisible to the user.
 * `list()` skips sidecar entries from results regardless of the entry-name
 * filter the calling backend applies on the body files.
 *
 * The default FileSyncBackend writes entries WITHOUT meta
 * (`writesEntryMeta: false`) — sidecars only appear if a future writer
 * passes meta to `write()`. The class supports them either way.
 *
 * `list(prefix)` recurses and excludes sidecar files from the result.
 * `copy(src, dst)` is emulated as read+write (meta + body) since FSA
 * has no server-side copy.
 */
@Injectable({ providedIn: 'root' })
export class FileBlobStore implements BlobStore {
    readonly permission = inject(FileBackendPermissionService);

    private async getRoot(): Promise<FileSystemDirectoryHandle> {
        const h = this.permission.handle();
        if (!h) throw new Error('File sync backend: no folder bound. Pick one in Settings.');
        return h;
    }

    private splitPath(path: string): { dirParts: string[]; name: string } {
        const parts = splitDir(path);
        if (parts.length === 0) throw new Error(`FileBlobStore: empty path`);
        return { dirParts: parts.slice(0, -1), name: parts[parts.length - 1] };
    }

    async list(prefix: string, options?: BlobListOptions): Promise<BlobListEntry[]> {
        const root = await this.getRoot();
        const cleanPrefix = prefix.replace(/\/+$/, '');
        const dirParts = cleanPrefix ? splitDir(cleanPrefix) : [];
        const dir = await getDirIfExists(root, dirParts);
        if (!dir) return [];
        const out: BlobListEntry[] = [];
        await this.listRecursive(dir, cleanPrefix, options?.withMeta !== false, out);
        return out;
    }

    private async listRecursive(
        dir: FileSystemDirectoryHandle,
        pathPrefix: string,
        withMeta: boolean,
        out: BlobListEntry[]
    ): Promise<void> {
        // Pass 1: split files from sidecars (so the body pass attaches
        // meta in O(1)) and recurse into subdirs. Sidecar reads are
        // skipped entirely when withMeta=false.
        const sidecarByName = new Map<string, FileSystemFileHandle>();
        const bodyFiles: { name: string; handle: FileSystemFileHandle }[] = [];
        const subDirs: { name: string; handle: FileSystemDirectoryHandle }[] = [];
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind === 'directory') {
                subDirs.push({ name, handle: handle as FileSystemDirectoryHandle });
                continue;
            }
            if (handle.kind !== 'file') continue;
            if (name.endsWith(META_SUFFIX)) {
                if (withMeta) {
                    const targetName = name.slice(0, -META_SUFFIX.length);
                    sidecarByName.set(targetName, handle as FileSystemFileHandle);
                }
                // else: silently drop sidecars from results so caller
                // doesn't see them as data files.
            } else {
                bodyFiles.push({ name, handle: handle as FileSystemFileHandle });
            }
        }

        // Hydrate body files in parallel — `getFile()` + `readSidecar()`
        // are independent async I/O per file, so a parallel pool wins on
        // folders with many entries (large libraries) without overwhelming
        // the FSA implementation's connection ceiling.
        const hydrated: BlobListEntry[] = new Array(bodyFiles.length);
        await parallelPool(bodyFiles, async ({ name, handle }, i) => {
            const file = await handle.getFile();
            const entryPath = pathPrefix ? `${pathPrefix}/${name}` : name;
            const sidecar = withMeta ? sidecarByName.get(name) : undefined;
            const meta = sidecar ? await this.readSidecar(sidecar) : {};
            hydrated[i] = {
                path: entryPath,
                meta,
                modifiedAt: file.lastModified,
                size: file.size
            };
        });
        for (const e of hydrated) out.push(e);

        // Subdirs walked sequentially — recursion depth is small for our
        // layouts (snapshots: 3-4 levels) and parallelising would explode
        // the global pool's effective concurrency past SNAPSHOT_CONCURRENCY.
        for (const { name, handle } of subDirs) {
            const subPath = pathPrefix ? `${pathPrefix}/${name}` : name;
            await this.listRecursive(handle, subPath, withMeta, out);
        }
    }

    async read(path: string): Promise<BlobReadResult> {
        const root = await this.getRoot();
        const { dirParts, name } = this.splitPath(path);
        const dir = await getDirIfExists(root, dirParts);
        if (!dir) throw new Error(`FileBlobStore: ${path} not found (dir missing)`);
        let bodyHandle: FileSystemFileHandle;
        try {
            bodyHandle = await dir.getFileHandle(name, { create: false });
        } catch (e) {
            if (isNotFound(e)) throw new Error(`FileBlobStore: ${path} not found`);
            throw e;
        }
        const file = await bodyHandle.getFile();
        const text = await file.text();
        let meta: BlobMeta = {};
        try {
            const sidecarHandle = await dir.getFileHandle(name + META_SUFFIX, { create: false });
            meta = await this.readSidecar(sidecarHandle);
        } catch (e) {
            if (!isNotFound(e)) throw e;
        }
        return { text, meta, modifiedAt: file.lastModified, size: file.size };
    }

    async write(path: string, text: string, meta?: BlobMeta): Promise<void> {
        const root = await this.getRoot();
        const { dirParts, name } = this.splitPath(path);
        const dir = await ensureDir(root, dirParts);
        await this.writeFile(dir, name, text);

        const metaName = name + META_SUFFIX;
        if (meta && Object.keys(meta).length > 0) {
            await this.writeFile(dir, metaName, JSON.stringify(meta));
        } else {
            // Caller passed empty/no meta — clear any pre-existing sidecar
            // so a write never leaves stale meta behind.
            try { await dir.removeEntry(metaName); } catch (e) {
                if (!isNotFound(e)) throw e;
            }
        }
    }

    async remove(path: string): Promise<void> {
        const root = await this.getRoot();
        const { dirParts, name } = this.splitPath(path);
        const dir = await getDirIfExists(root, dirParts);
        if (!dir) return;
        try { await dir.removeEntry(name); } catch (e) {
            if (!isNotFound(e)) throw e;
        }
        try { await dir.removeEntry(name + META_SUFFIX); } catch (e) {
            if (!isNotFound(e)) throw e;
        }
    }

    async copy(srcPath: string, dstPath: string): Promise<void> {
        const result = await this.read(srcPath);
        await this.write(dstPath, result.text, result.meta);
    }

    async listFolders(prefix: string): Promise<string[]> {
        const root = await this.getRoot();
        const cleanPrefix = prefix.replace(/\/+$/, '');
        const dirParts = cleanPrefix ? splitDir(cleanPrefix) : [];
        const dir = await getDirIfExists(root, dirParts);
        if (!dir) return [];
        const out: string[] = [];
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind === 'directory') out.push(name);
        }
        return out;
    }

    async removeFolder(path: string): Promise<void> {
        const root = await this.getRoot();
        const cleanPath = path.replace(/\/+$/, '');
        const parts = splitDir(cleanPath);
        if (parts.length === 0) return; // refuse to wipe the root
        const parent = await getDirIfExists(root, parts.slice(0, -1));
        if (!parent) return;
        try {
            await parent.removeEntry(parts[parts.length - 1], { recursive: true });
        } catch (e) {
            if (!isNotFound(e)) throw e;
        }
    }

    async exists(path: string): Promise<boolean> {
        const root = await this.getRoot();
        const { dirParts, name } = this.splitPath(path);
        const dir = await getDirIfExists(root, dirParts);
        if (!dir) return false;
        try {
            await dir.getFileHandle(name, { create: false });
            return true;
        } catch (e) {
            if (isNotFound(e)) return false;
            throw e;
        }
    }

    private async readSidecar(handle: FileSystemFileHandle): Promise<BlobMeta> {
        try {
            const file = await handle.getFile();
            const text = await file.text();
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object') return parsed as BlobMeta;
            return {};
        } catch {
            return {};
        }
    }

    private async writeFile(
        dir: FileSystemDirectoryHandle,
        name: string,
        content: string
    ): Promise<void> {
        const fh = await dir.getFileHandle(name, { create: true });
        const writable = await fh.createWritable({ keepExistingData: false });
        try {
            await writable.write(content);
        } finally {
            await writable.close();
        }
    }
}
