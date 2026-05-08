import { Injectable, inject } from '@angular/core';
import {
    SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId,
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotLocalPayload
} from '../sync.types';
import { FileBackendPermissionService } from './file-backend-permission.service';
import { FileBlobStore } from './file-blob-store';
import { createParallelPool } from '@app/core/utils/async.util';
import { FileSnapshotStore } from './file-snapshot-store';
import { SNAPSHOT_CONCURRENCY } from '../sync-snapshot-utils';
import {
    RESOURCE_DIR, TOMBSTONE_DIR, entryPath, entryDirPrefix
} from '../layout/sync-paths';
import { blobEntryToRemoteEntry } from '../domain/entry-mapper';
import { SettingsRepository } from '../domain/settings-repository';
import { PromptsRepository } from '../domain/prompts-repository';
import {
    TombstoneRepository, UNDERSCORE_FILE_TOMBSTONE_LAYOUT
} from '../domain/tombstone-repository';

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);

/**
 * Resource entry filename: `<id>.json`. We must reject conflict-marker
 * filenames that cloud-mirror tools drop next to the originals — they
 * contain a copy of valid JSON, so a body-parse safety net wouldn't
 * catch them; they'd be ingested as books with junk ids and propagate
 * cross-device. The regex enforces the basic `<id>.json` shape and
 * rejects anything containing `(`, `)`, or whitespace, which covers
 * Dropbox's `Foo (1).json`-style patterns. {@link isConflictName}
 * handles the more exotic cases.
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
    private readonly blob = inject(FileBlobStore);

    private readonly tombstones = new TombstoneRepository(this.blob, UNDERSCORE_FILE_TOMBSTONE_LAYOUT);
    private readonly settings = new SettingsRepository(this.blob);
    private readonly prompts = new PromptsRepository(this.blob);

    isReady(): boolean { return this.permission.handle() !== null; }
    isAuthenticated(): boolean { return this.permission.permissionState() === 'granted'; }
    /** SyncService calls this on every public entry point — re-acquires
     *  FSA permission inside the user-gesture call stack on first use of
     *  a tab session; subsequent calls land 'granted' instantly. */
    async authenticate(): Promise<void> { await this.permission.ensurePermission(); }
    async initAsync(): Promise<void> {
        // No lazy module to load; FSA handle is already in memory after
        // the user picked the folder.
    }
    configFingerprint(): string {
        // FSA handles aren't structurally comparable across reloads (the
        // browser opaque-keys them), but identity is stable within a tab —
        // bump on bind/unbind transitions only.
        return this.permission.handle() ? 'bound' : '';
    }

    // ===== Live tree IO ===================================================

    async list(resource: SyncResource): Promise<RemoteEntry[]> {
        const dirPrefix = entryDirPrefix(resource);
        const blobEntries = await this.blob.list(dirPrefix);

        // Filter cloud-mirror conflict files + non-`<id>.json` shapes BEFORE
        // hydrating timestamps — saves N body reads on a folder polluted
        // with conflicts.
        const candidates: { id: string; entry: typeof blobEntries[number] }[] = [];
        for (const e of blobEntries) {
            const name = e.path.slice(dirPrefix.length);
            if (name.includes('/')) continue; // a nested folder shouldn't end up here
            if (isConflictName(name)) continue;
            const m = ENTRY_RE.exec(name);
            if (!m) continue;
            candidates.push({ id: m[1], entry: e });
        }

        const out: RemoteEntry[] = new Array(candidates.length);
        await parallelPool(candidates, async (c, i) => {
            out[i] = await blobEntryToRemoteEntry(this.blob, c.entry, c.id);
        });
        return out;
    }

    read(resource: SyncResource, id: string): Promise<string> {
        return this.blob.read(entryPath(resource, id)).then(r => r.text);
    }

    // `lastActiveAt` is unused: FSA has no native per-file metadata, and
    // the value is already on the body (clean.util stamps it). Skipping
    // the sidecar write keeps the user's local sync folder from doubling
    // in file count and matches the pre-refactor on-disk shape verbatim.
    // entry-mapper.list() recovers `lastActiveAt` from the body — same
    // behaviour as before.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    write(resource: SyncResource, id: string, json: string, lastActiveAt: number): Promise<void> {
        return this.blob.write(entryPath(resource, id), json);
    }

    remove(resource: SyncResource, id: string): Promise<void> {
        return this.blob.remove(entryPath(resource, id));
    }

    // ===== Tombstones =====================================================

    listTombstones(resource: SyncResource): Promise<Tombstone[]> {
        return this.tombstones.list(resource);
    }

    /**
     * Sweeps older tombstones for the same id before writing the new one
     * so the on-disk folder doesn't grow each delete-restore-redelete cycle.
     * S3 / GDrive tolerate the accumulation (object overhead is negligible),
     * but a local folder is a user-visible artefact — keep it tidy.
     */
    async writeTombstone(resource: SyncResource, id: string, deletedAt: number): Promise<void> {
        const prefix = `${TOMBSTONE_DIR[resource]}/`;
        const entries = await this.blob.list(prefix);
        for (const e of entries) {
            const rel = e.path.slice(prefix.length);
            const parsed = UNDERSCORE_FILE_TOMBSTONE_LAYOUT.parseRelative(rel, e.meta);
            if (parsed?.id === id && parsed.deletedAt < deletedAt) {
                try { await this.blob.remove(e.path); } catch { /* best-effort */ }
            }
        }
        await this.tombstones.write(resource, id, deletedAt);
    }

    clearTombstones(resource: SyncResource): Promise<void> {
        return this.tombstones.clear(resource);
    }

    // ===== Settings / Prompts ===========================================

    readSettings(): Promise<string | null> { return this.settings.read(); }
    writeSettings(content: string): Promise<void> { return this.settings.write(content); }
    readPrompts(): Promise<string | null> { return this.prompts.read(); }
    writePrompts(content: string): Promise<void> { return this.prompts.write(content); }

    // ===== Snapshots — delegated to FileSnapshotStore (unchanged in PR2) =

    private async getRoot(): Promise<FileSystemDirectoryHandle> {
        const h = this.permission.handle();
        if (!h) throw new Error('File sync backend: no folder bound. Pick one in Settings.');
        return h;
    }

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
