import { BlobStore } from '../blob-store';
import {
    SyncResource, SnapshotMeta, SnapshotManifest, Tombstone, assertSnapshotId
} from '../sync.types';
import { manifestToMeta } from '../sync-snapshot-utils';
import {
    SNAPSHOTS_DIR, META_LAST_ACTIVE, entryPath
} from '../layout/sync-paths';
import { TombstoneLayout } from './tombstone-repository';
import { SnapshotTreeOps } from './snapshot-tree-ops';

const MANIFEST_NAME = 'manifest.json';

/**
 * BlobStore-backed implementation of {@link SnapshotTreeOps}. Layout:
 *
 *   `snapshots/<sid>/manifest.json`
 *   `snapshots/<sid>/<RESOURCE_DIR[r]>/<id>.json`                (entries)
 *   `snapshots/<sid>/<tombLayout.pathFor(r, id, deletedAt)>`     (tombstones)
 *
 * The tombstone layout matches the backend's LIVE layout (slash or
 * underscore) so existing snapshots created pre-PR3 remain readable
 * — `BlobSnapshotTreeOps` doesn't impose a uniform tombstone shape on
 * the snapshot tree.
 *
 * Server-side copy comes free from {@link BlobStore.copy} — S3 / GDrive
 * use the native fast path; File falls back to read+write under the hood.
 */
export class BlobSnapshotTreeOps implements SnapshotTreeOps {
    /**
     * @param snapshotsRoot Top-level folder name for the snapshot tree.
     *   Defaults to `SNAPSHOTS_DIR` (`'snapshots'`). GDrive passes
     *   `'snapshots_root'` so existing user snapshots created before the
     *   PR3 collapse remain restorable — older code wrote them under
     *   `appDataFolder/snapshots_root/<sid>/...`.
     */
    constructor(
        private readonly blob: BlobStore,
        private readonly tombLayout: TombstoneLayout,
        private readonly snapshotsRoot: string = SNAPSHOTS_DIR
    ) {}

    private snapshotPath(snapshotId: string, sub = ''): string {
        return sub
            ? `${this.snapshotsRoot}/${snapshotId}/${sub}`
            : `${this.snapshotsRoot}/${snapshotId}`;
    }

    private snapshotManifestPath(snapshotId: string): string {
        return this.snapshotPath(snapshotId, MANIFEST_NAME);
    }

    private snapshotEntryPath(snapshotId: string, resource: SyncResource, id: string): string {
        return this.snapshotPath(snapshotId, entryPath(resource, id));
    }

    private snapshotTombstonePath(
        snapshotId: string, resource: SyncResource, id: string, deletedAt: number
    ): string {
        return this.snapshotPath(snapshotId, this.tombLayout.pathFor(resource, id, deletedAt));
    }

    private livePathForEntry(resource: SyncResource, id: string): string {
        return entryPath(resource, id);
    }

    private livePathForTombstone(resource: SyncResource, id: string, deletedAt: number): string {
        return this.tombLayout.pathFor(resource, id, deletedAt);
    }

    async listSnapshots(): Promise<SnapshotMeta[]> {
        // `listFolders` on `<snapshotsRoot>/` returns the immediate
        // subfolder names — i.e. snapshot ids. Cheap on every backend
        // (S3: one ListObjectsV2 with Delimiter; GDrive: one folder
        // listing call); avoids the full-tree recursion a generic
        // `list()` + filter would do.
        const sids = await this.blob.listFolders(`${this.snapshotsRoot}/`);
        const out: SnapshotMeta[] = [];
        for (const id of sids) {
            try {
                out.push(manifestToMeta(await this.readManifest(id)));
            } catch {
                // Skip unreadable / corrupt manifests; UI shouldn't fail
                // listSnapshots because of one bad snapshot.
            }
        }
        return out;
    }

    async readManifest(snapshotId: string): Promise<SnapshotManifest> {
        assertSnapshotId(snapshotId);
        const result = await this.blob.read(this.snapshotManifestPath(snapshotId));
        return JSON.parse(result.text) as SnapshotManifest;
    }

    async writeManifest(snapshotId: string, manifest: SnapshotManifest): Promise<void> {
        assertSnapshotId(snapshotId);
        await this.blob.write(this.snapshotManifestPath(snapshotId), JSON.stringify(manifest));
    }

    async updateNote(snapshotId: string, note: string): Promise<void> {
        const manifest = await this.readManifest(snapshotId);
        manifest.note = note;
        await this.writeManifest(snapshotId, manifest);
    }

    async deleteSnapshotTree(snapshotId: string): Promise<void> {
        assertSnapshotId(snapshotId);
        await this.blob.removeFolder(this.snapshotPath(snapshotId));
    }

    async copyEntry(snapshotId: string, resource: SyncResource, id: string): Promise<void> {
        await this.blob.copy(
            this.livePathForEntry(resource, id),
            this.snapshotEntryPath(snapshotId, resource, id)
        );
    }

    async copyTombstone(snapshotId: string, resource: SyncResource, tomb: Tombstone): Promise<void> {
        await this.blob.copy(
            this.livePathForTombstone(resource, tomb.id, tomb.deletedAt),
            this.snapshotTombstonePath(snapshotId, resource, tomb.id, tomb.deletedAt)
        );
    }

    async writeEntry(
        snapshotId: string, resource: SyncResource, id: string,
        json: string, lastActiveAt: number
    ): Promise<void> {
        await this.blob.write(
            this.snapshotEntryPath(snapshotId, resource, id),
            json,
            { [META_LAST_ACTIVE]: String(lastActiveAt) }
        );
    }

    async writeTombstone(
        snapshotId: string, resource: SyncResource, id: string, deletedAt: number
    ): Promise<void> {
        await this.blob.write(
            this.snapshotTombstonePath(snapshotId, resource, id, deletedAt),
            ''
        );
    }

    async readEntry(snapshotId: string, resource: SyncResource, id: string): Promise<string> {
        const result = await this.blob.read(this.snapshotEntryPath(snapshotId, resource, id));
        return result.text;
    }
}
