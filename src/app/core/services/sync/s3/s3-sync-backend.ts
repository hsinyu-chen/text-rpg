import { Injectable, inject } from '@angular/core';
import {
    SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId, S3Config,
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotLocalPayload
} from '../sync.types';
import { S3ClientService } from './s3-client.service';
import { S3BlobStore } from './s3-blob-store';
import { createParallelPool } from '@app/core/utils/async.util';
import { SNAPSHOT_CONCURRENCY } from '../sync-snapshot-utils';
import { entryPath, RESOURCE_DIR, META_LAST_ACTIVE } from '../layout/sync-paths';
import { blobEntryToRemoteEntry } from '../domain/entry-mapper';
import { SettingsRepository } from '../domain/settings-repository';
import { PromptsRepository } from '../domain/prompts-repository';
import { SLASH_TOMBSTONE_LAYOUT, TombstoneRepository } from '../domain/tombstone-repository';
import { BlobSnapshotTreeOps } from '../domain/blob-snapshot-tree-ops';
import { SnapshotStore } from '../domain/snapshot-store';

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);

@Injectable({ providedIn: 'root' })
export class S3SyncBackend implements SyncBackend {
    readonly id: SyncBackendId = 's3';
    readonly label = 'S3-compatible';
    readonly supportsBackgroundSync = true;

    private readonly clientSvc = inject(S3ClientService);
    private readonly blob = inject(S3BlobStore);

    private readonly tombstones = new TombstoneRepository(this.blob, SLASH_TOMBSTONE_LAYOUT);
    private readonly settings = new SettingsRepository(this.blob);
    private readonly prompts = new PromptsRepository(this.blob);

    isReady(): boolean { return this.clientSvc.isReady(); }
    isAuthenticated(): boolean { return this.clientSvc.isAuthenticated(); }
    authenticate(): Promise<void> { return this.clientSvc.authenticate(); }
    configFingerprint(): string { return this.clientSvc.configFingerprint(); }
    initAsync(): Promise<void> { return this.clientSvc.initAsync(); }

    /** UI helper: validate a candidate config without binding the singleton. */
    testConfig(config: S3Config): Promise<void> { return this.clientSvc.testConfig(config); }

    // ===== Live tree IO ===================================================

    async list(resource: SyncResource): Promise<RemoteEntry[]> {
        const dirPrefix = `${RESOURCE_DIR[resource]}/`;
        const blobEntries = await this.blob.list(dirPrefix);

        // Filter to well-formed `<id>.json` entries BEFORE the hydration
        // pool — entry-mapper would otherwise fan out wasted GET-body
        // fallbacks on stray non-`.json` keys (anything someone left in
        // the prefix that doesn't match our layout).
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
        return this.blob.read(entryPath(resource, id)).then(r => r.text);
    }

    write(resource: SyncResource, id: string, json: string, lastActiveAt: number): Promise<void> {
        return this.blob.write(entryPath(resource, id), json, {
            [META_LAST_ACTIVE]: String(lastActiveAt)
        });
    }

    remove(resource: SyncResource, id: string): Promise<void> {
        return this.blob.remove(entryPath(resource, id));
    }

    // ===== Tombstones =====================================================

    listTombstones(resource: SyncResource): Promise<Tombstone[]> {
        return this.tombstones.list(resource);
    }
    writeTombstone(resource: SyncResource, id: string, deletedAt: number): Promise<void> {
        return this.tombstones.write(resource, id, deletedAt);
    }
    clearTombstones(resource: SyncResource): Promise<void> {
        return this.tombstones.clear(resource);
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
        new BlobSnapshotTreeOps(this.blob, SLASH_TOMBSTONE_LAYOUT)
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
