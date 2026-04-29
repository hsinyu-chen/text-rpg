/**
 * Shared File System Access API helpers used by every backend / service that
 * operates on a `FileSystemDirectoryHandle`. Originally inlined inside
 * `file-sync-backend.ts`; extracted here so disk profile sync can reuse them
 * without going through SyncBackend's wider surface.
 */

export function splitDir(path: string): string[] {
    return path.split('/').filter(p => p.length > 0);
}

/**
 * Walk `parts` from `root`, creating missing intermediates. Always returns
 * a handle on success; throws on FS error. Use this when the directory
 * MUST exist after the call (writes, snapshot creation).
 */
export async function ensureDir(
    root: FileSystemDirectoryHandle,
    parts: string[]
): Promise<FileSystemDirectoryHandle> {
    let cur: FileSystemDirectoryHandle = root;
    for (const part of parts) {
        cur = await cur.getDirectoryHandle(part, { create: true });
    }
    return cur;
}

/**
 * Like `ensureDir` but read-only: returns `null` if any segment is missing.
 * Use this for list/read paths where "directory doesn't exist yet" maps to
 * "no entries" rather than an error.
 */
export async function getDirIfExists(
    root: FileSystemDirectoryHandle,
    parts: string[]
): Promise<FileSystemDirectoryHandle | null> {
    let cur: FileSystemDirectoryHandle = root;
    for (const part of parts) {
        try {
            cur = await cur.getDirectoryHandle(part, { create: false });
        } catch (e) {
            if (isNotFound(e)) return null;
            throw e;
        }
    }
    return cur;
}

export async function readFileText(
    dir: FileSystemDirectoryHandle,
    name: string
): Promise<string | null> {
    let fh: FileSystemFileHandle;
    try {
        fh = await dir.getFileHandle(name, { create: false });
    } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
    }
    const file = await fh.getFile();
    return file.text();
}

/**
 * Atomic-replace write: `createWritable` opens a hidden temp file under the
 * platform's atomic-rename semantics and `close()` swaps it into place.
 * Readers either see the old or the new bytes, never a torn intermediate.
 */
export async function writeFileText(
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

export function isNotFound(e: unknown): boolean {
    if (e instanceof DOMException) {
        return e.name === 'NotFoundError';
    }
    return false;
}
