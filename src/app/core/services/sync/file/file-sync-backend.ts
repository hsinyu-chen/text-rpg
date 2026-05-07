import { Injectable, inject } from '@angular/core';
import {
    SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId,
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotLocalPayload
} from '../sync.types';
import { FileBackendPermissionService } from './file-backend-permission.service';
import { ensureDir, getDirIfExists, isNotFound, readFileText, splitDir, writeFileText } from '../fsa-utils';
import { createParallelPool } from '@app/core/utils/async.util';
import { FileSnapshotStore } from './file-snapshot-store';
import { SNAPSHOT_CONCURRENCY } from '../sync-snapshot-utils';

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
const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);
/**
 * Tombstone filename: `<id>__<deletedAt>.json`. The `__` separator is
 * deliberately not a single `_` (UUIDs / nanoid never contain double
 * underscore, but single underscore is plausible in custom id schemes).
 */
const TOMBSTONE_RE = /^(.+)__(\d+)\.json$/;

/**
 * Resource entry filename: `<id>.json`. We must reject conflict-marker
 * filenames that cloud-mirror tools drop next to the originals — they
 * contain a copy of valid JSON, so a body-parse safety net wouldn't
 * catch them; they'd be ingested as books with junk ids and propagate
 * cross-device. The blocklist (`isConflictName`) handles the two we
 * know about; the regex then enforces the basic `<id>.json` shape and
 * rejects anything containing `(`, `)`, or whitespace, which covers
 * additional Dropbox patterns like `Foo (1).json`.
 */
const ENTRY_RE = /^([^()\s]+)\.json$/;

/**
 * Returns true when a filename matches a known cloud-mirror conflict
 * pattern that should be skipped on `list()`.
 *  - Dropbox: `Foo (1).json`, `Foo (2).json`, …
 *  - Syncthing: `Foo.sync-conflict-20250101-120000-DEVICEID.json`
 *  - iCloud: `Foo (Conflicted copy).json` (also handled by paren rule)
 */
function isConflictName(name: string): boolean {
    if (name.includes('.sync-conflict')) return true;
    if (/\(\d+\)/.test(name)) return true;
    if (name.toLowerCase().includes('conflicted copy')) return true;
    return false;
}

@Injectable({ providedIn: 'root' })
export class FileSyncBackend implements SyncBackend {
    readonly id: SyncBackendId = 'file';
    readonly label = 'Local Folder';
    /**
     * Forced false because re-acquiring File System Access permission after
     * a page reload requires a user gesture (`requestPermission` only
     * surfaces the prompt inside transient activation). UI never lets the
     * user enable an auto-sync toggle for this backend.
     */
    readonly supportsBackgroundSync = false;

    readonly permission = inject(FileBackendPermissionService);

    isReady(): boolean {
        return this.permission.handle() !== null;
    }

    configFingerprint(): string {
        // FSA handles aren't structurally comparable across reloads (the
        // browser opaque-keys them), but identity is stable within a tab —
        // bump on bind/unbind transitions only.
        return this.permission.handle() ? 'bound' : '';
    }

    async initAsync(): Promise<void> {
        // No lazy module to load; FSA handle is already in memory after
        // the user picked the folder. authenticate() handles permission
        // re-grant inside a user gesture.
    }

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
        for await (const [name, handle] of dir.entries()) {
            if (handle.kind !== 'file') continue;
            if (isConflictName(name)) continue;
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
        return out;
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
        for await (const [name, handle] of dir.entries()) {
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
        for await (const [name, handle] of dir.entries()) {
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

    // ===== Snapshots — delegated to FileSnapshotStore ====================

    private readonly snapshotStore = new FileSnapshotStore({
        getRoot: () => this.getRoot(),
        resourceDir: RESOURCE_DIR,
        tombstoneDir: TOMBSTONE_DIR,
        ops: {
            list: (r) => this.list(r),
            listTombstones: (r) => this.listTombstones(r),
            write: (r, id, json, ts) => this.write(r, id, json, ts),
            writeTombstone: (r, id, ts) => this.writeTombstone(r, id, ts),
            remove: (r, id) => this.remove(r, id)
        }
    });

    listSnapshots(): Promise<SnapshotMeta[]> { return this.snapshotStore.listSnapshots(); }
    readSnapshotManifest(id: string): Promise<SnapshotManifest> { return this.snapshotStore.readSnapshotManifest(id); }
    createSnapshotFromCloud(id: string, meta: SnapshotMetaInput): Promise<SnapshotManifest> {
        return this.snapshotStore.createSnapshotFromCloud(id, meta);
    }
    createSnapshotFromLocal(id: string, meta: SnapshotMetaInput, payload: SnapshotLocalPayload): Promise<SnapshotManifest> {
        return this.snapshotStore.createSnapshotFromLocal(id, meta, payload);
    }
    restoreSnapshot(id: string): Promise<void> { return this.snapshotStore.restoreSnapshot(id); }
    deleteSnapshot(id: string): Promise<void> { return this.snapshotStore.deleteSnapshot(id); }
    updateSnapshotNote(id: string, note: string): Promise<void> {
        return this.snapshotStore.updateSnapshotNote(id, note);
    }
}
