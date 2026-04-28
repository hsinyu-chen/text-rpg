import { Injectable, inject } from '@angular/core';
import {
    SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId,
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotEntryRef,
    SnapshotTombstoneRef, SnapshotSkipped, SnapshotLocalPayload, assertSnapshotId
} from './sync.types';
import { FileBackendPermissionService } from './file-backend-permission.service';

const RESOURCE_DIR: Record<SyncResource, string> = {
    book: 'books',
    collection: 'collections'
};
const TOMBSTONE_DIR: Record<SyncResource, string> = {
    book: 'tombstones/books',
    collection: 'tombstones/collections'
};
const SETTINGS_NAME = 'settings.json';
const PROMPTS_NAME = 'prompts.json';
const SNAPSHOTS_DIR = 'snapshots';
const SNAPSHOT_MANIFEST_NAME = 'manifest.json';
const SNAPSHOT_CONCURRENCY = 8;

/**
 * Tombstone filename: `<id>__<deletedAt>.json`. The `__` separator is
 * deliberately not a single `_` (UUIDs / nanoid never contain double
 * underscore, but single underscore is plausible in custom id schemes).
 */
const TOMBSTONE_RE = /^(.+)__(\d+)\.json$/;

/**
 * Resource entry filename: `<id>.json`. We accept any id that doesn't
 * embed `(` or space (those are the tell-tales of Dropbox conflict
 * filenames like `Foo (1).json`); body-parse failures further down are
 * skipped with a warn so any other crud — including Syncthing
 * `.sync-conflict-*` — never crashes a sync.
 */
const ENTRY_RE = /^([^()\s]+)\.json$/;

@Injectable({ providedIn: 'root' })
export class FileSyncBackend implements SyncBackend {
    readonly id: SyncBackendId = 'file';
    readonly label = 'Local Folder';
    readonly isConfigured = true;
    /**
     * Forced false because re-acquiring File System Access permission after
     * a page reload requires a user gesture (`requestPermission` only
     * surfaces the prompt inside transient activation). UI never lets the
     * user enable an auto-sync toggle for this backend.
     */
    readonly supportsBackgroundSync = false;

    readonly permission = inject(FileBackendPermissionService);

    isAuthenticated(): boolean {
        return this.permission.permissionState() === 'granted';
    }

    /**
     * SyncService calls this on every public entry point. We piggyback on it
     * to (re)acquire FSA permission — `ensurePermission` only needs to be
     * inside a user-gesture call stack on the first call of a tab session;
     * subsequent calls within the same session are 'granted' instantly.
     */
    async authenticate(): Promise<void> {
        await this.permission.ensurePermission();
    }

    private async getRoot(): Promise<FileSystemDirectoryHandle> {
        const h = this.permission.handle();
        if (!h) {
            // Should never reach here — SyncService.getActiveBackend awaits
            // ensurePermission before handing the backend out — but guard
            // anyway so a plain `read()` from a unit test is debuggable.
            throw new Error('File sync backend: no folder bound. Pick one in Settings.');
        }
        return h;
    }

    // ===== Live tree IO ==================================================

    async list(resource: SyncResource): Promise<RemoteEntry[]> {
        const root = await this.getRoot();
        const dir = await getDirIfExists(root, [RESOURCE_DIR[resource]]);
        if (!dir) return [];

        const candidates: { id: string; handle: FileSystemFileHandle }[] = [];
        for await (const [name, handle] of entries(dir)) {
            if (handle.kind !== 'file') continue;
            const m = ENTRY_RE.exec(name);
            if (!m) continue;
            candidates.push({ id: m[1], handle: handle as FileSystemFileHandle });
        }

        // Hydrate per-file: read body, parse lastActiveAt. Local FS reads
        // are fast enough that a parallel pool isn't critical, but matches
        // the S3 path's shape so future tweaks land in both.
        const out: RemoteEntry[] = new Array(candidates.length);
        await parallelPool(candidates, async (c, i) => {
            const file = await c.handle.getFile();
            const modifiedAt = file.lastModified;
            const fallback: RemoteEntry = {
                id: c.id,
                lastActiveAt: modifiedAt,
                modifiedAt,
                size: file.size
            };
            try {
                const text = await file.text();
                const body = JSON.parse(text) as { lastActiveAt?: number; updatedAt?: number };
                const bodyTime = Number(body.lastActiveAt ?? body.updatedAt) || modifiedAt;
                out[i] = { ...fallback, lastActiveAt: bodyTime };
            } catch (e) {
                console.warn(`[FileBackend] list: failed to parse ${RESOURCE_DIR[resource]}/${c.id}.json; using mtime`, e);
                out[i] = fallback;
            }
        });
        // Drop any skipped slots (none currently — parse failures fall back
        // to mtime — but keep the filter to mirror `list()` output shape).
        return out.filter((e): e is RemoteEntry => !!e);
    }

    async read(resource: SyncResource, id: string): Promise<string> {
        const root = await this.getRoot();
        const dir = await getDirIfExists(root, [RESOURCE_DIR[resource]]);
        if (!dir) throw new Error(`File: missing ${RESOURCE_DIR[resource]} dir`);
        const text = await readFileText(dir, `${id}.json`);
        if (text === null) throw new Error(`File: not found ${resource}/${id}`);
        return text;
    }

    // `lastActiveAt` is unused: FSA has no per-file metadata, and the value
    // is already on the body (clean.util stamps it before this layer). list()
    // reads it back from the body. Parameter kept for SyncBackend interface
    // parity with S3 / Drive (which DO use it for object metadata).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async write(resource: SyncResource, id: string, json: string, lastActiveAt: number): Promise<void> {
        const root = await this.getRoot();
        const dir = await ensureDir(root, [RESOURCE_DIR[resource]]);
        await writeFileText(dir, `${id}.json`, json);
    }

    async remove(resource: SyncResource, id: string): Promise<void> {
        const root = await this.getRoot();
        const dir = await getDirIfExists(root, [RESOURCE_DIR[resource]]);
        if (!dir) return;
        try {
            await dir.removeEntry(`${id}.json`);
        } catch (e) {
            if (isNotFound(e)) return;
            throw e;
        }
    }

    // ===== Tombstones ====================================================

    async listTombstones(resource: SyncResource): Promise<Tombstone[]> {
        const root = await this.getRoot();
        const dir = await getDirIfExists(root, splitDir(TOMBSTONE_DIR[resource]));
        if (!dir) return [];

        const latest = new Map<string, number>();
        for await (const [name, handle] of entries(dir)) {
            if (handle.kind !== 'file') continue;
            const m = TOMBSTONE_RE.exec(name);
            if (!m) continue;
            const id = m[1];
            const deletedAt = Number(m[2]);
            if (!Number.isFinite(deletedAt)) continue;
            const prev = latest.get(id);
            if (prev === undefined || deletedAt > prev) latest.set(id, deletedAt);
        }
        return Array.from(latest, ([id, deletedAt]) => ({ id, deletedAt }));
    }

    async writeTombstone(resource: SyncResource, id: string, deletedAt: number): Promise<void> {
        const root = await this.getRoot();
        const dir = await ensureDir(root, splitDir(TOMBSTONE_DIR[resource]));

        // Sweep older tombstones for the same id so the directory doesn't
        // grow each delete-restore-redelete cycle. listTombstones only ever
        // returns the max deletedAt per id, so older keys are dead weight.
        for await (const [name, handle] of entries(dir)) {
            if (handle.kind !== 'file') continue;
            const m = TOMBSTONE_RE.exec(name);
            if (!m || m[1] !== id) continue;
            const existing = Number(m[2]);
            if (Number.isFinite(existing) && existing < deletedAt) {
                try { await dir.removeEntry(name); } catch { /* best-effort */ }
            }
        }

        await writeFileText(dir, `${id}__${deletedAt}.json`, '{}');
    }

    async clearTombstones(resource: SyncResource): Promise<void> {
        const root = await this.getRoot();
        const parts = splitDir(TOMBSTONE_DIR[resource]);
        const parent = await getDirIfExists(root, parts.slice(0, -1));
        if (!parent) return;
        try {
            await parent.removeEntry(parts[parts.length - 1], { recursive: true });
        } catch (e) {
            if (isNotFound(e)) return;
            throw e;
        }
    }

    // ===== Settings / Prompts ===========================================

    async readSettings(): Promise<string | null> {
        const root = await this.getRoot();
        return readFileText(root, SETTINGS_NAME);
    }

    async writeSettings(content: string): Promise<void> {
        const root = await this.getRoot();
        await writeFileText(root, SETTINGS_NAME, content);
    }

    async readPrompts(): Promise<string | null> {
        const root = await this.getRoot();
        return readFileText(root, PROMPTS_NAME);
    }

    async writePrompts(content: string): Promise<void> {
        const root = await this.getRoot();
        await writeFileText(root, PROMPTS_NAME, content);
    }

    // ===== Snapshots =====================================================

    private async snapshotsDirIfExists(): Promise<FileSystemDirectoryHandle | null> {
        const root = await this.getRoot();
        return getDirIfExists(root, [SNAPSHOTS_DIR]);
    }

    private async snapshotDirIfExists(snapshotId: string): Promise<FileSystemDirectoryHandle | null> {
        const root = await this.getRoot();
        return getDirIfExists(root, [SNAPSHOTS_DIR, snapshotId]);
    }

    private async ensureSnapshotDir(snapshotId: string): Promise<FileSystemDirectoryHandle> {
        const root = await this.getRoot();
        return ensureDir(root, [SNAPSHOTS_DIR, snapshotId]);
    }

    async listSnapshots(): Promise<SnapshotMeta[]> {
        const dir = await this.snapshotsDirIfExists();
        if (!dir) return [];

        const ids: string[] = [];
        for await (const [name, handle] of entries(dir)) {
            if (handle.kind === 'directory') ids.push(name);
        }

        const metas: (SnapshotMeta | null)[] = new Array(ids.length);
        await parallelPool(ids, async (id, i) => {
            try {
                const manifest = await this.readSnapshotManifest(id);
                // Drop the heavy `entries` array for the list-level view.
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const { entries: _drop, ...meta } = manifest;
                metas[i] = meta;
            } catch (e) {
                console.warn(`[FileBackend] Failed to read snapshot manifest for ${id}; skipping.`, e);
                metas[i] = null;
            }
        });
        return metas.filter((m): m is SnapshotMeta => m !== null);
    }

    async readSnapshotManifest(snapshotId: string): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);
        const dir = await this.snapshotDirIfExists(snapshotId);
        if (!dir) throw new Error(`File: snapshot ${snapshotId} not found`);
        const text = await readFileText(dir, SNAPSHOT_MANIFEST_NAME);
        if (text === null) throw new Error(`File: missing manifest for snapshot ${snapshotId}`);
        return JSON.parse(text) as SnapshotManifest;
    }

    async createSnapshotFromCloud(
        snapshotId: string,
        meta: SnapshotMetaInput
    ): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);

        // 1. Snapshot the live state.
        const [books, collections, bookTombs, collTombs] = await Promise.all([
            this.list('book'),
            this.list('collection'),
            this.listTombstones('book'),
            this.listTombstones('collection')
        ]);

        // 2. Book-wins dedupe.
        const bookIds = new Set(books.map(b => b.id));
        const collIds = new Set(collections.map(c => c.id));
        const filteredBookTombs = bookTombs.filter(t => !bookIds.has(t.id));
        const filteredCollTombs = collTombs.filter(t => !collIds.has(t.id));

        const skipped: SnapshotSkipped[] = [];
        const snapDir = await this.ensureSnapshotDir(snapshotId);
        const booksDir = await ensureDir(snapDir, [RESOURCE_DIR.book]);
        const collsDir = await ensureDir(snapDir, [RESOURCE_DIR.collection]);
        const tombBooksDir = await ensureDir(snapDir, splitDir(TOMBSTONE_DIR.book));
        const tombCollsDir = await ensureDir(snapDir, splitDir(TOMBSTONE_DIR.collection));

        // 3. Read live → write to snapshot subtree (no server-side copy on FSA).
        const bookEntries: SnapshotEntryRef[] = [];
        await parallelPool(books, async (b) => {
            try {
                const text = await this.read('book', b.id);
                await writeFileText(booksDir, `${b.id}.json`, text);
                bookEntries.push({
                    id: b.id,
                    lastActiveAt: b.lastActiveAt,
                    size: byteLength(text)
                });
            } catch (e) {
                if (isNotFound(e)) {
                    skipped.push({ resource: 'book', id: b.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        const collectionEntries: SnapshotEntryRef[] = [];
        await parallelPool(collections, async (c) => {
            try {
                const text = await this.read('collection', c.id);
                await writeFileText(collsDir, `${c.id}.json`, text);
                collectionEntries.push({
                    id: c.id,
                    lastActiveAt: c.lastActiveAt,
                    size: byteLength(text)
                });
            } catch (e) {
                if (isNotFound(e)) {
                    skipped.push({ resource: 'collection', id: c.id, reason: 'source 404 mid-snapshot' });
                    return;
                }
                throw e;
            }
        });

        // 4. Tombstones — body is just `{}`, deletedAt is encoded in filename.
        const tombstoneEntries: SnapshotTombstoneRef[] = [];
        await parallelPool(filteredBookTombs, async (t) => {
            await writeFileText(tombBooksDir, `${t.id}__${t.deletedAt}.json`, '{}');
            tombstoneEntries.push({ resource: 'book', id: t.id, deletedAt: t.deletedAt });
        });
        await parallelPool(filteredCollTombs, async (t) => {
            await writeFileText(tombCollsDir, `${t.id}__${t.deletedAt}.json`, '{}');
            tombstoneEntries.push({ resource: 'collection', id: t.id, deletedAt: t.deletedAt });
        });

        // 5. Build & write manifest.
        const sizeBytes = sumSizes(bookEntries) + sumSizes(collectionEntries);
        const manifest: SnapshotManifest = {
            id: snapshotId,
            createdAt: meta.createdAt,
            trigger: meta.trigger,
            note: meta.note,
            deviceId: meta.deviceId,
            bookCount: bookEntries.length,
            collectionCount: collectionEntries.length,
            tombstoneCount: tombstoneEntries.length,
            sizeBytes: sizeBytes > 0 ? sizeBytes : undefined,
            skippedIds: skipped.length > 0 ? skipped : undefined,
            version: 1,
            entries: {
                book: bookEntries,
                collection: collectionEntries,
                tombstone: tombstoneEntries
            }
        };
        await writeFileText(snapDir, SNAPSHOT_MANIFEST_NAME, JSON.stringify(manifest));
        return manifest;
    }

    async createSnapshotFromLocal(
        snapshotId: string,
        meta: SnapshotMetaInput,
        payload: SnapshotLocalPayload
    ): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);

        const bookIds = new Set(payload.books.map(b => b.id));
        const collIds = new Set(payload.collections.map(c => c.id));
        const filteredTombs = payload.tombstones.filter(t => {
            if (t.resource === 'book') return !bookIds.has(t.id);
            return !collIds.has(t.id);
        });

        const skipped: SnapshotSkipped[] = [];
        const snapDir = await this.ensureSnapshotDir(snapshotId);
        const booksDir = await ensureDir(snapDir, [RESOURCE_DIR.book]);
        const collsDir = await ensureDir(snapDir, [RESOURCE_DIR.collection]);
        const tombBooksDir = await ensureDir(snapDir, splitDir(TOMBSTONE_DIR.book));
        const tombCollsDir = await ensureDir(snapDir, splitDir(TOMBSTONE_DIR.collection));

        const bookEntries: SnapshotEntryRef[] = [];
        await parallelPool(payload.books, async (b) => {
            await writeFileText(booksDir, `${b.id}.json`, b.json);
            bookEntries.push({
                id: b.id,
                lastActiveAt: b.lastActiveAt,
                size: byteLength(b.json)
            });
        });

        const collectionEntries: SnapshotEntryRef[] = [];
        await parallelPool(payload.collections, async (c) => {
            await writeFileText(collsDir, `${c.id}.json`, c.json);
            collectionEntries.push({
                id: c.id,
                lastActiveAt: c.lastActiveAt,
                size: byteLength(c.json)
            });
        });

        const tombstoneEntries: SnapshotTombstoneRef[] = [];
        await parallelPool(filteredTombs, async (t) => {
            const dir = t.resource === 'book' ? tombBooksDir : tombCollsDir;
            await writeFileText(dir, `${t.id}__${t.deletedAt}.json`, '{}');
            tombstoneEntries.push({ resource: t.resource, id: t.id, deletedAt: t.deletedAt });
        });

        const sizeBytes = sumSizes(bookEntries) + sumSizes(collectionEntries);
        const manifest: SnapshotManifest = {
            id: snapshotId,
            createdAt: meta.createdAt,
            trigger: meta.trigger,
            note: meta.note,
            deviceId: meta.deviceId,
            bookCount: bookEntries.length,
            collectionCount: collectionEntries.length,
            tombstoneCount: tombstoneEntries.length,
            sizeBytes: sizeBytes > 0 ? sizeBytes : undefined,
            skippedIds: skipped.length > 0 ? skipped : undefined,
            version: 1,
            entries: {
                book: bookEntries,
                collection: collectionEntries,
                tombstone: tombstoneEntries
            }
        };
        await writeFileText(snapDir, SNAPSHOT_MANIFEST_NAME, JSON.stringify(manifest));
        return manifest;
    }

    async restoreSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);

        // 1. Read manifest first — abort cleanly if it's missing/corrupt.
        const manifest = await this.readSnapshotManifest(snapshotId);

        // 2. Snapshot live state for diff-delete (BEFORE any writes).
        const [liveBooks, liveCollections] = await Promise.all([
            this.list('book'),
            this.list('collection')
        ]);

        const root = await this.getRoot();
        const snapDir = await this.snapshotDirIfExists(snapshotId);
        if (!snapDir) throw new Error(`File: snapshot ${snapshotId} directory missing`);
        const snapBooksDir = await getDirIfExists(snapDir, [RESOURCE_DIR.book]);
        const snapCollsDir = await getDirIfExists(snapDir, [RESOURCE_DIR.collection]);

        const liveBooksDir = await ensureDir(root, [RESOURCE_DIR.book]);
        const liveCollsDir = await ensureDir(root, [RESOURCE_DIR.collection]);

        const now = Date.now();

        // 3. Re-stamp body lastActiveAt = now and write to live.
        await parallelPool(manifest.entries.book, async (e) => {
            if (!snapBooksDir) throw new Error(`File: snapshot books dir missing in ${snapshotId}`);
            const text = await readFileText(snapBooksDir, `${e.id}.json`);
            if (text === null) throw new Error(`File: snapshot book body missing for ${e.id}`);
            const restamped = restampBodyLastActive(text, now);
            await writeFileText(liveBooksDir, `${e.id}.json`, restamped);
        });
        await parallelPool(manifest.entries.collection, async (e) => {
            if (!snapCollsDir) throw new Error(`File: snapshot collections dir missing in ${snapshotId}`);
            const text = await readFileText(snapCollsDir, `${e.id}.json`);
            if (text === null) throw new Error(`File: snapshot collection body missing for ${e.id}`);
            const restamped = restampBodyLastActive(text, now);
            await writeFileText(liveCollsDir, `${e.id}.json`, restamped);
        });

        // 4. Wipe live tombstone trees and re-write at deletedAt = now.
        //    (Same semantics as S3 backend — manifest already deduped.)
        await this.clearTombstones('book');
        await this.clearTombstones('collection');
        await parallelPool(manifest.entries.tombstone, async (t) => {
            await this.writeTombstone(t.resource, t.id, now);
        });

        // 5. Diff-delete: live entries not in manifest.
        const manifestBookIds = new Set(manifest.entries.book.map(e => e.id));
        const manifestCollIds = new Set(manifest.entries.collection.map(e => e.id));
        const booksToDelete = liveBooks.filter(b => !manifestBookIds.has(b.id));
        const collsToDelete = liveCollections.filter(c => !manifestCollIds.has(c.id));
        await parallelPool(booksToDelete, async (b) => this.remove('book', b.id));
        await parallelPool(collsToDelete, async (c) => this.remove('collection', c.id));
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const parent = await this.snapshotsDirIfExists();
        if (!parent) return;
        try {
            await parent.removeEntry(snapshotId, { recursive: true });
        } catch (e) {
            if (isNotFound(e)) return;
            throw e;
        }
    }

    async updateSnapshotNote(snapshotId: string, note: string): Promise<void> {
        assertSnapshotId(snapshotId);
        const dir = await this.snapshotDirIfExists(snapshotId);
        if (!dir) throw new Error(`File: snapshot ${snapshotId} not found`);
        const manifest = await this.readSnapshotManifest(snapshotId);
        manifest.note = note;
        await writeFileText(dir, SNAPSHOT_MANIFEST_NAME, JSON.stringify(manifest));
    }
}

// ===== Module-private helpers ============================================

function splitDir(path: string): string[] {
    return path.split('/').filter(p => p.length > 0);
}

/**
 * Walk `parts` from `root`, creating missing intermediates. Always returns
 * a handle on success; throws on FS error. Use this when the directory
 * MUST exist after the call (writes, snapshot creation).
 */
async function ensureDir(
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
async function getDirIfExists(
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

async function readFileText(
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
async function writeFileText(
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

async function* entries(
    dir: FileSystemDirectoryHandle
): AsyncIterable<[string, FileSystemHandle]> {
    for await (const entry of dir.entries()) {
        yield entry;
    }
}

function isNotFound(e: unknown): boolean {
    if (e instanceof DOMException) {
        return e.name === 'NotFoundError';
    }
    return false;
}

async function parallelPool<T>(
    items: T[],
    worker: (item: T, idx: number) => Promise<void>,
    concurrency = SNAPSHOT_CONCURRENCY
): Promise<void> {
    if (items.length === 0) return;
    let cursor = 0;
    const runners = Array.from(
        { length: Math.min(concurrency, items.length) },
        async () => {
            while (cursor < items.length) {
                const i = cursor++;
                await worker(items[i], i);
            }
        }
    );
    await Promise.all(runners);
}

function byteLength(s: string): number {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    return s.length;
}

function sumSizes(items: SnapshotEntryRef[]): number {
    let total = 0;
    for (const e of items) {
        if (e.size !== undefined) total += e.size;
    }
    return total;
}

/**
 * Replaces `lastActiveAt` in a JSON body. Mirrors S3 backend behaviour: if
 * parse fails or the field is absent the body is returned unchanged so the
 * snapshot data is at least preserved verbatim. List-time recovery still
 * works because list() falls back to mtime when body parse fails.
 */
function restampBodyLastActive(text: string, now: number): string {
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            (parsed as Record<string, unknown>)['lastActiveAt'] = now;
            return JSON.stringify(parsed);
        }
    } catch {
        // fall through
    }
    return text;
}
