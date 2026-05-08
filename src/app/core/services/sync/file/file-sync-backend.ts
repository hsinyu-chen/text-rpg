import { Injectable, inject } from '@angular/core';
import { SyncResource } from '../sync.types';
import { FileBackendPermissionService } from './file-backend-permission.service';
import { FileBlobStore } from './file-blob-store';
import { TOMBSTONE_DIR, entryPath, entryDirPrefix } from '../layout/sync-paths';
import { UNDERSCORE_FILE_TOMBSTONE_LAYOUT } from '../domain/tombstone-repository';
import { GenericSyncBackend, ClientLifecycle } from '../generic-sync-backend';
import { BlobStore } from '../blob-store';

/**
 * Resource entry filename: `<id>.json`. The regex enforces the basic
 * shape and rejects anything containing `(`, `)`, or whitespace, which
 * covers Dropbox's `Foo (1).json`-style patterns. {@link isConflictName}
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

/**
 * File-System-Access flavoured `SyncBackend`. Auth lifecycle is delegated
 * to {@link FileBackendPermissionService}; live IO and snapshot ops fall
 * through to {@link GenericSyncBackend}. File-specific concerns wired here:
 *
 *   - `entryNameFilter` to drop cloud-mirror conflict files (Dropbox /
 *     Syncthing / iCloud) — without it those files get ingested as
 *     books with junk ids and propagate cross-device.
 *   - `writesEntryMeta: false` — FSA has no native per-file metadata
 *     and we don't want to double the user's local-folder file count
 *     with `<path>.meta.json` sidecars. The body already has
 *     `lastActiveAt`; entry-mapper recovers it from there.
 *   - `onBeforeWriteTombstone` hook that sweeps older tombstones for
 *     the same id — the local sync folder is a user-visible artefact
 *     (S3 / GDrive tolerate accumulation; File doesn't).
 */
@Injectable({ providedIn: 'root' })
export class FileSyncBackend extends GenericSyncBackend {
    /** Re-exposed for the FSA permission UI gates. */
    readonly permission: FileBackendPermissionService;

    constructor() {
        const blob = inject(FileBlobStore);
        const permission = inject(FileBackendPermissionService);
        super({
            id: 'file',
            label: 'Local Folder',
            // FSA permission re-acquisition needs a user gesture on
            // every reload; auto-sync is impossible.
            supportsBackgroundSync: false,
            blob,
            lifecycle: makeFileLifecycle(permission),
            entryPathFor: entryPath,
            entryDirPrefix,
            entryNameFilter: (name) => !isConflictName(name) && ENTRY_RE.test(name),
            writesEntryMeta: false,
            tombstoneLayout: UNDERSCORE_FILE_TOMBSTONE_LAYOUT,
            onBeforeWriteTombstone: (r, id, deletedAt) =>
                sweepOlderTombstones(blob, r, id, deletedAt)
        });
        this.permission = permission;
    }
}

function makeFileLifecycle(permission: FileBackendPermissionService): ClientLifecycle {
    return {
        isReady: () => permission.handle() !== null,
        isAuthenticated: () => permission.permissionState() === 'granted',
        async authenticate() { await permission.ensurePermission(); },
        async initAsync() {
            // No lazy module to load; the FSA handle is already in
            // memory after the user picked the folder.
        },
        configFingerprint: () => permission.handle() ? 'bound' : ''
    };
}

async function sweepOlderTombstones(
    blob: BlobStore, resource: SyncResource, id: string, deletedAt: number
): Promise<void> {
    const prefix = `${TOMBSTONE_DIR[resource]}/`;
    const entries = await blob.list(prefix, { withMeta: false });
    for (const e of entries) {
        const rel = e.path.slice(prefix.length);
        const parsed = UNDERSCORE_FILE_TOMBSTONE_LAYOUT.parseRelative(rel, e.meta);
        if (parsed?.id === id && parsed.deletedAt < deletedAt) {
            try { await blob.remove(e.path); } catch { /* best-effort */ }
        }
    }
}
