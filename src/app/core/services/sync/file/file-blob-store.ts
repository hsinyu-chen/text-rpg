import { Injectable, inject } from '@angular/core';
import { BlobListEntry, BlobMeta, BlobReadResult, BlobStore } from '../blob-store';
import { FileBackendPermissionService } from './file-backend-permission.service';
import { ensureDir, getDirIfExists, isNotFound, splitDir } from '../fsa-utils';

const META_SUFFIX = '.meta.json';

/**
 * BlobStore over File System Access (FSA). FSA has no native per-file
 * metadata; to honour the BlobStore contract that `meta` round-trips,
 * we store the meta as a sidecar JSON file next to the body:
 *
 *   `books/abc.json`           ← body
 *   `books/abc.json.meta.json` ← meta sidecar (omitted if meta is empty)
 *
 * The sidecar is intentionally `*.meta.json` rather than `*.meta` so:
 *   1. The cloud-mirror conflict detection in FileSyncBackend.list (which
 *      checks for `(N)`-style filenames) keeps working — sidecars get the
 *      same conflict patterns and the parser already rejects `.meta.json`
 *      via the `<id>.json` regex.
 *   2. Editors that hide non-`.json` files don't make sidecars invisible.
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

    async list(prefix: string): Promise<BlobListEntry[]> {
        const root = await this.getRoot();
        const cleanPrefix = prefix.replace(/\/+$/, '');
        const dirParts = cleanPrefix ? splitDir(cleanPrefix) : [];
        const dir = await getDirIfExists(root, dirParts);
        if (!dir) return [];
        const out: BlobListEntry[] = [];
        await this.listRecursive(dir, cleanPrefix, out);
        return out;
    }

    private async listRecursive(
        dir: FileSystemDirectoryHandle,
        pathPrefix: string,
        out: BlobListEntry[]
    ): Promise<void> {
        // Pass 1: index sidecars by their target body path so the body
        // pass can attach meta in O(1).
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
                const targetName = name.slice(0, -META_SUFFIX.length);
                sidecarByName.set(targetName, handle as FileSystemFileHandle);
            } else {
                bodyFiles.push({ name, handle: handle as FileSystemFileHandle });
            }
        }

        for (const { name, handle } of bodyFiles) {
            const file = await handle.getFile();
            const entryPath = pathPrefix ? `${pathPrefix}/${name}` : name;
            const sidecar = sidecarByName.get(name);
            const meta = sidecar ? await this.readSidecar(sidecar) : {};
            out.push({
                path: entryPath,
                meta,
                modifiedAt: file.lastModified,
                size: file.size
            });
        }
        for (const { name, handle } of subDirs) {
            const subPath = pathPrefix ? `${pathPrefix}/${name}` : name;
            await this.listRecursive(handle, subPath, out);
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
