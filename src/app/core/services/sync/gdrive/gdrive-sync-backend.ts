import { Injectable, inject } from '@angular/core';
import { GoogleDriveService } from '../../google-drive.service';
import { GoogleOAuthService } from '../../google-oauth.service';
import { KVStore } from '../../kv/kv-store';
import { SyncResource, SyncBackendId } from '../sync.types';
import { BlobStore } from '../blob-store';
import { GDriveBlobStore } from './gdrive-blob-store';
import { tombstonePath } from '../layout/sync-paths';
import { SLASH_TOMBSTONE_LAYOUT } from '../domain/tombstone-repository';
import { GenericSyncBackend, ClientLifecycle } from '../generic-sync-backend';

// GDrive-specific live-tree folder names. `books_v1` is preserved from
// the legacy layout — renaming would orphan existing user data.
// Collections never had a versioned name. These differ from the unified
// `RESOURCE_DIR` (`books` / `collections`) used by S3 + File.
const GDRIVE_ENTRY_DIR: Record<SyncResource, string> = {
    book: 'books_v1',
    collection: 'collections'
};

// Pre-migration tombstone folder names (flat, with deletedAt in
// appProperties). After migration completes, these folders are emptied
// and removed; new tombstones land at `tombstones/<r>/<id>/<deletedAt>`.
const LEGACY_TOMBSTONE_FOLDER: Record<SyncResource, string> = {
    book: 'tombstones_books',
    collection: 'tombstones_collections'
};
const LEGACY_DELETED_AT_PROP = 'deleted-at';

function gdriveEntryPath(r: SyncResource, id: string): string {
    return `${GDRIVE_ENTRY_DIR[r]}/${id}.json`;
}
function gdriveEntryDirPrefix(r: SyncResource): string {
    return `${GDRIVE_ENTRY_DIR[r]}/`;
}

/**
 * Google-Drive-flavoured `SyncBackend`. Auth lifecycle is delegated to
 * {@link GoogleOAuthService}; live IO and snapshot ops fall through to
 * {@link GenericSyncBackend}. GDrive-specific concerns wired here:
 *
 *   - Custom `entryPathFor` to keep the legacy `books_v1` folder.
 *   - `snapshotsRoot: 'snapshots_root'` so existing user snapshots
 *     remain restorable (older code wrote them under
 *     `appDataFolder/snapshots_root/...`).
 *   - One-time tombstone-layout migration via the
 *     `onBeforeListTombstones / Write / Clear` hooks.
 */
@Injectable({ providedIn: 'root' })
export class GDriveSyncBackend extends GenericSyncBackend {
    constructor() {
        const blob = inject(GDriveBlobStore);
        const oauth = inject(GoogleOAuthService);
        const drive = inject(GoogleDriveService);
        const kv = inject(KVStore);
        const migration = makeTombstoneMigrator(blob, drive, kv);
        super({
            id: 'gdrive' as SyncBackendId,
            label: 'Google Drive',
            supportsBackgroundSync: false,
            blob,
            lifecycle: makeGDriveLifecycle(oauth),
            entryPathFor: gdriveEntryPath,
            entryDirPrefix: gdriveEntryDirPrefix,
            tombstoneLayout: SLASH_TOMBSTONE_LAYOUT,
            // GDrive's pre-collapse snapshot store wrote under
            // `appDataFolder/snapshots_root/<sid>/...`. Keep the root
            // name so existing user snapshots remain restorable.
            snapshotsRoot: 'snapshots_root',
            onBeforeListTombstones: (r) => migration(r),
            onBeforeWriteTombstone: (r) => migration(r),
            onBeforeClearTombstones: (r) => migration(r)
        });
    }
}

function makeGDriveLifecycle(oauth: GoogleOAuthService): ClientLifecycle {
    return {
        isReady: () => oauth.isConfigured,
        isAuthenticated: () => oauth.isAuthenticated(),
        async authenticate() { await oauth.login(); },
        async initAsync() {
            // GoogleOAuthService loads GIS lazily; backend has no
            // per-init state to build. authenticate() handles refresh.
        },
        // OAuth state — the auth boundary is the only meaningful change
        // for the breaker (re-OAuth after token revocation should reset).
        configFingerprint: () => oauth.isAuthenticated() ? 'auth' : ''
    };
}

/**
 * Returns a per-resource lazy migrator. First call per resource per
 * session reads the legacy `tombstones_<r>/<id>` flat layout
 * (deletedAt in `appProperties.deleted-at`) and rewrites under the new
 * `tombstones/<r>/<id>/<deletedAt>` slash layout. Idempotent via a
 * KVStore flag; mid-migration interruption is safe (un-migrated keys
 * retried next call; `blob.write` is idempotent for unchanged content).
 *
 * If migration fails (network blip, permission), the flag is NOT set
 * and we retry next call. TombstoneRepository.list still works
 * correctly — it just transiently misses un-migrated entries until
 * migration completes.
 */
function makeTombstoneMigrator(
    blob: GDriveBlobStore,
    drive: GoogleDriveService,
    kv: KVStore
): (r: SyncResource) => Promise<void> {
    const migrated = new Set<SyncResource>();
    return async function ensure(resource: SyncResource): Promise<void> {
        if (migrated.has(resource)) return;
        const flagKey = `gdrive_tombstone_migration_v2_${resource}`;
        if (kv.get(flagKey) === 'done') {
            migrated.add(resource);
            return;
        }
        const legacyFolderName = LEGACY_TOMBSTONE_FOLDER[resource];
        const legacyEntries = await (blob as BlobStore).list(`${legacyFolderName}/`);
        for (const entry of legacyEntries) {
            // Path shape: `<legacyFolderName>/<id>` (one segment after prefix).
            const id = entry.path.slice(legacyFolderName.length + 1);
            if (!id || id.includes('/')) continue;
            const rawTs = entry.meta[LEGACY_DELETED_AT_PROP];
            const deletedAt = rawTs ? Number(rawTs) : NaN;
            const ts = Number.isFinite(deletedAt) && deletedAt > 0
                ? deletedAt
                : entry.modifiedAt; // fallback: same policy the pre-refactor backend used
            if (!Number.isFinite(ts) || ts <= 0) continue;
            await (blob as BlobStore).write(tombstonePath(resource, id, ts), '');
            await (blob as BlobStore).remove(entry.path);
        }
        // Best-effort cleanup of the now-empty legacy folder. Failure
        // here doesn't compromise correctness; just leaves a stray
        // empty folder under appDataFolder.
        try {
            const folders = await drive.listFolders('appDataFolder');
            const legacy = folders.find(f => f.name === legacyFolderName);
            if (legacy) {
                const remaining = await drive.listFiles(legacy.id);
                if (remaining.length === 0) await drive.deleteFile(legacy.id);
            }
        } catch (e) {
            console.warn(`[GDrive] migration: failed to clean up legacy ${legacyFolderName}`, e);
        }
        kv.set(flagKey, 'done');
        migrated.add(resource);
        // BlobStore caches now reference the deleted legacy folder /
        // moved files — invalidate rather than surgically prune.
        blob.invalidateCaches();
    };
}
