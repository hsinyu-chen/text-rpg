import { Injectable, inject } from '@angular/core';
import { GoogleDriveService } from '../../google-drive.service';
import { GoogleOAuthService } from '../../google-oauth.service';
import { KVStore } from '../../kv/kv-store';
import {
    SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId,
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotLocalPayload
} from '../sync.types';
import { GDriveBlobStore } from './gdrive-blob-store';
import { createParallelPool } from '@app/core/utils/async.util';
import { SNAPSHOT_CONCURRENCY } from '../sync-snapshot-utils';
import { META_LAST_ACTIVE, tombstonePath } from '../layout/sync-paths';
import { blobEntryToRemoteEntry } from '../domain/entry-mapper';
import { SettingsRepository } from '../domain/settings-repository';
import { PromptsRepository } from '../domain/prompts-repository';
import { SLASH_TOMBSTONE_LAYOUT, TombstoneRepository } from '../domain/tombstone-repository';
import { BlobSnapshotTreeOps } from '../domain/blob-snapshot-tree-ops';
import { SnapshotStore } from '../domain/snapshot-store';

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);

// GDrive-specific live-tree folder names. `books_v1` is preserved from the
// legacy layout — renaming would orphan existing user data. Collections
// never had a versioned name. These differ from the unified RESOURCE_DIR
// (`books` / `collections`) used by S3 + File on purpose; PR4's
// GenericSyncBackend will surface this asymmetry as an explicit
// per-backend paths config.
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

@Injectable({ providedIn: 'root' })
export class GDriveSyncBackend implements SyncBackend {
    readonly id: SyncBackendId = 'gdrive';
    readonly label = 'Google Drive';
    readonly supportsBackgroundSync = false;

    private drive = inject(GoogleDriveService);
    private oauth = inject(GoogleOAuthService);
    private kv = inject(KVStore);
    private blob = inject(GDriveBlobStore);

    private readonly tombstones = new TombstoneRepository(this.blob, SLASH_TOMBSTONE_LAYOUT);
    private readonly settings = new SettingsRepository(this.blob);
    private readonly prompts = new PromptsRepository(this.blob);

    /** Per-resource flag: tombstone migration v2 (flat → slash layout)
     *  done. Persisted in KVStore so a re-launch doesn't re-run. */
    private migratedResources = new Set<SyncResource>();

    isReady(): boolean { return this.oauth.isConfigured; }
    isAuthenticated(): boolean { return this.oauth.isAuthenticated(); }
    async authenticate(): Promise<void> { await this.oauth.login(); }
    async initAsync(): Promise<void> {
        // GoogleOAuthService loads GIS lazily; backend has no per-init
        // state to build. authenticate() handles token refresh.
    }
    configFingerprint(): string {
        return this.oauth.isAuthenticated() ? 'auth' : '';
    }

    // ===== Live tree IO ===================================================

    async list(resource: SyncResource): Promise<RemoteEntry[]> {
        const dirPrefix = gdriveEntryDirPrefix(resource);
        const blobEntries = await this.blob.list(dirPrefix);
        const candidates = blobEntries
            .filter(e => e.path.endsWith('.json'))
            .map(e => ({ entry: e, id: e.path.slice(dirPrefix.length, -5) }))
            .filter(c => c.id.length > 0);
        const out: RemoteEntry[] = new Array(candidates.length);
        await parallelPool(candidates, async (c, i) => {
            out[i] = await blobEntryToRemoteEntry(this.blob, c.entry, c.id);
        });
        return out;
    }

    read(resource: SyncResource, id: string): Promise<string> {
        return this.blob.read(gdriveEntryPath(resource, id)).then(r => r.text);
    }

    write(resource: SyncResource, id: string, json: string, lastActiveAt: number): Promise<void> {
        return this.blob.write(gdriveEntryPath(resource, id), json, {
            [META_LAST_ACTIVE]: String(lastActiveAt)
        });
    }

    remove(resource: SyncResource, id: string): Promise<void> {
        return this.blob.remove(gdriveEntryPath(resource, id));
    }

    // ===== Tombstones (with one-time legacy migration) ====================

    async listTombstones(resource: SyncResource): Promise<Tombstone[]> {
        await this.ensureTombstoneMigration(resource);
        return this.tombstones.list(resource);
    }
    async writeTombstone(resource: SyncResource, id: string, deletedAt: number): Promise<void> {
        await this.ensureTombstoneMigration(resource);
        return this.tombstones.write(resource, id, deletedAt);
    }
    async clearTombstones(resource: SyncResource): Promise<void> {
        await this.ensureTombstoneMigration(resource);
        return this.tombstones.clear(resource);
    }

    /**
     * One-time migration from the legacy flat layout
     * (`tombstones_<r>/<id>` + appProperty `deleted-at`) to the unified
     * path-based layout (`tombstones/<r>/<id>/<deletedAt>`).
     *
     * Runs lazily on first tombstone op per resource per session. The
     * `gdrive_tombstone_migration_v2_<r>` flag in KVStore prevents repeats
     * across sessions. Mid-migration interruption is safe — surviving
     * old files get migrated next run; `blob.write` is idempotent for
     * unchanged content.
     *
     * If migration fails (network, permission), the flag is NOT set and
     * we retry next call. TombstoneRepository.list still works correctly
     * (reads new-layout entries), just transiently misses un-migrated
     * ones until migration completes.
     */
    private async ensureTombstoneMigration(resource: SyncResource): Promise<void> {
        if (this.migratedResources.has(resource)) return;
        const flagKey = `gdrive_tombstone_migration_v2_${resource}`;
        if (this.kv.get(flagKey) === 'done') {
            this.migratedResources.add(resource);
            return;
        }

        const legacyFolderName = LEGACY_TOMBSTONE_FOLDER[resource];
        const legacyEntries = await this.blob.list(`${legacyFolderName}/`);
        for (const entry of legacyEntries) {
            // path shape: `<legacyFolderName>/<id>` (one segment after prefix)
            const id = entry.path.slice(legacyFolderName.length + 1);
            if (!id || id.includes('/')) continue;
            const rawTs = entry.meta[LEGACY_DELETED_AT_PROP];
            const deletedAt = rawTs ? Number(rawTs) : NaN;
            const ts = Number.isFinite(deletedAt) && deletedAt > 0
                ? deletedAt
                : entry.modifiedAt; // fallback: same policy as the pre-refactor backend
            if (!Number.isFinite(ts) || ts <= 0) continue;
            await this.blob.write(tombstonePath(resource, id, ts), '');
            await this.blob.remove(entry.path);
        }
        // Best-effort cleanup of the now-empty legacy folder. Failure
        // here doesn't compromise correctness; it just leaves a stray
        // empty folder under appDataFolder.
        try {
            const folders = await this.drive.listFolders('appDataFolder');
            const legacy = folders.find(f => f.name === legacyFolderName);
            if (legacy) {
                const remaining = await this.drive.listFiles(legacy.id);
                if (remaining.length === 0) await this.drive.deleteFile(legacy.id);
            }
        } catch (e) {
            console.warn(`[GDrive] migration: failed to clean up legacy ${legacyFolderName}`, e);
        }

        this.kv.set(flagKey, 'done');
        this.migratedResources.add(resource);
        // BlobStore caches now reference the deleted legacy folder /
        // moved files — invalidate rather than surgically prune.
        this.blob.invalidateCaches();
    }

    // ===== Settings / Prompts =============================================

    readSettings(): Promise<string | null> { return this.settings.read(); }
    writeSettings(content: string): Promise<void> { return this.settings.write(content); }
    readPrompts(): Promise<string | null> { return this.prompts.read(); }
    writePrompts(content: string): Promise<void> { return this.prompts.write(content); }

    // ===== Snapshots — delegated to the shared SnapshotStore ============

    private readonly snapshotStore = new SnapshotStore(
        {
            list: (r) => this.list(r),
            listTombstones: (r) => this.listTombstones(r),
            write: (r, id, json, ts) => this.write(r, id, json, ts),
            writeTombstone: (r, id, ts) => this.writeTombstone(r, id, ts),
            remove: (r, id) => this.remove(r, id),
            removeTombstone: (r, id) => this.tombstones.removeById(r, id)
        },
        // GDrive's pre-collapse snapshot store wrote under
        // `appDataFolder/snapshots_root/<sid>/...`. Keep the root name
        // so existing user snapshots remain restorable. PR4 may revisit
        // (rename to match S3/File on a separate migration step).
        new BlobSnapshotTreeOps(this.blob, SLASH_TOMBSTONE_LAYOUT, 'snapshots_root')
    );

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
