import {
    SyncBackend, SyncResource, RemoteEntry, Tombstone, SyncBackendId,
    SnapshotMeta, SnapshotManifest, SnapshotMetaInput, SnapshotLocalPayload
} from './sync.types';
import { BlobStore } from './blob-store';
import { createParallelPool } from '@app/core/utils/async.util';
import { SNAPSHOT_CONCURRENCY } from './sync-snapshot-utils';
import { META_LAST_ACTIVE, SNAPSHOTS_DIR } from './layout/sync-paths';
import { blobEntryToRemoteEntry } from './domain/entry-mapper';
import { SettingsRepository } from './domain/settings-repository';
import { PromptsRepository } from './domain/prompts-repository';
import { TombstoneRepository, TombstoneLayout } from './domain/tombstone-repository';
import { BlobSnapshotTreeOps } from './domain/blob-snapshot-tree-ops';
import { SnapshotStore } from './domain/snapshot-store';

const parallelPool = createParallelPool(SNAPSHOT_CONCURRENCY);

/**
 * The auth + connection lifecycle SyncBackend needs but BlobStore doesn't.
 * Each backend has a service that satisfies this interface (S3ClientService,
 * GoogleOAuthService, FileBackendPermissionService) — `GenericSyncBackend`
 * just calls into it.
 */
export interface ClientLifecycle {
    isReady(): boolean;
    isAuthenticated(): boolean;
    authenticate(): Promise<void>;
    initAsync(): Promise<void>;
    configFingerprint(): string;
}

/**
 * Configuration for {@link GenericSyncBackend} — the per-backend variation
 * factored out as data. Subclasses (S3SyncBackend / GDriveSyncBackend /
 * FileSyncBackend) construct one of these in their constructor and call
 * `super(config)`.
 */
export interface SyncBackendConfig {
    id: SyncBackendId;
    label: string;
    authActionLabel: string;
    supportsBackgroundSync: boolean;
    blob: BlobStore;
    lifecycle: ClientLifecycle;
    /**
     * Layout-aware path for an entry. Defaults `<RESOURCE_DIR[r]>/<id>.json`
     * but GDrive overrides to preserve its legacy `books_v1/<id>.json`
     * folder name.
     */
    entryPathFor(resource: SyncResource, id: string): string;
    /** Layout-aware list prefix matching {@link entryPathFor}'s parent. */
    entryDirPrefix(resource: SyncResource): string;
    /**
     * Optional name-level filter applied to `list()` results before they
     * reach the entry-mapper hydration pool. File backend uses it to
     * drop cloud-mirror conflict files (`Foo (1).json`, sync-conflict,
     * conflicted copy) so they don't get ingested as bogus entries with
     * junk ids and propagate cross-device. Default: accept everything.
     *
     * Receives the entry's filename WITHOUT the `<dirPrefix>` (e.g.
     * `'Foo (1).json'`, NOT `'books/Foo (1).json'`).
     */
    entryNameFilter?(name: string): boolean;
    /**
     * When `false`, `write()` skips passing user metadata to the
     * BlobStore. File backend opts out — FSA has no native per-file
     * metadata, so the BlobStore would otherwise emit a `<path>.meta.json`
     * sidecar that doubles the user's local-folder file count. The body
     * already contains `lastActiveAt`; entry-mapper recovers it from
     * there on read. Default: `true`.
     */
    writesEntryMeta?: boolean;
    tombstoneLayout: TombstoneLayout;
    /** Top-level snapshot folder name. Defaults `'snapshots'`; GDrive
     *  passes `'snapshots_root'` so existing snapshots remain accessible. */
    snapshotsRoot?: string;
    /**
     * Optional pre-op hooks. Used by GDrive (lazy tombstone-layout migration
     * before any tombstone read) and File (per-id hygiene sweep before
     * writing a new tombstone).
     */
    onBeforeListTombstones?(resource: SyncResource): Promise<void>;
    onBeforeWriteTombstone?(resource: SyncResource, id: string, deletedAt: number): Promise<void>;
    onBeforeClearTombstones?(resource: SyncResource): Promise<void>;
}

/**
 * Single concrete `SyncBackend` impl shared by every cloud / disk backend.
 * Per-backend variation is captured in the {@link SyncBackendConfig}
 * passed to `super()` from each subclass — the `id`, `label`, the BlobStore
 * implementation, the auth lifecycle, the entry path layout (`books_v1` on
 * GDrive vs the unified `books` elsewhere), the tombstone layout (slash
 * vs underscore), the snapshot root folder name, and any backend-specific
 * pre-op hooks (GDrive migration, File sweep).
 *
 * The class is concrete rather than abstract: subclasses exist only to
 * surface DI tokens (`inject(S3SyncBackend)` etc.) and host backend-
 * specific extras (`S3SyncBackend.testConfig`); they don't override any
 * behaviour. Adding a fourth backend means adding one subclass, not
 * touching this file.
 */
export class GenericSyncBackend implements SyncBackend {
    readonly id: SyncBackendId;
    readonly label: string;
    readonly authActionLabel: string;
    readonly supportsBackgroundSync: boolean;

    protected readonly blob: BlobStore;
    private readonly lifecycle: ClientLifecycle;
    private readonly entryPathFor: (resource: SyncResource, id: string) => string;
    private readonly entryDirPrefixFor: (resource: SyncResource) => string;
    private readonly entryNameFilter?: (name: string) => boolean;
    private readonly writesEntryMeta: boolean;
    private readonly hooks: Pick<SyncBackendConfig,
        'onBeforeListTombstones' | 'onBeforeWriteTombstone' | 'onBeforeClearTombstones'>;

    protected readonly tombstones: TombstoneRepository;
    private readonly settings: SettingsRepository;
    private readonly prompts: PromptsRepository;
    private readonly snapshots: SnapshotStore;

    constructor(config: SyncBackendConfig) {
        this.id = config.id;
        this.label = config.label;
        this.authActionLabel = config.authActionLabel;
        this.supportsBackgroundSync = config.supportsBackgroundSync;
        this.blob = config.blob;
        this.lifecycle = config.lifecycle;
        this.entryPathFor = config.entryPathFor;
        this.entryDirPrefixFor = config.entryDirPrefix;
        this.entryNameFilter = config.entryNameFilter;
        this.writesEntryMeta = config.writesEntryMeta !== false;
        this.hooks = {
            onBeforeListTombstones: config.onBeforeListTombstones,
            onBeforeWriteTombstone: config.onBeforeWriteTombstone,
            onBeforeClearTombstones: config.onBeforeClearTombstones
        };
        this.tombstones = new TombstoneRepository(this.blob, config.tombstoneLayout);
        this.settings = new SettingsRepository(this.blob);
        this.prompts = new PromptsRepository(this.blob);
        this.snapshots = new SnapshotStore(
            {
                list: (r) => this.list(r),
                listTombstones: (r) => this.listTombstones(r),
                write: (r, id, json, ts) => this.write(r, id, json, ts),
                writeTombstone: (r, id, ts) => this.writeTombstone(r, id, ts),
                remove: (r, id) => this.remove(r, id),
                removeTombstone: (r, id) => this.tombstones.removeById(r, id)
            },
            new BlobSnapshotTreeOps(
                this.blob,
                config.tombstoneLayout,
                config.snapshotsRoot ?? SNAPSHOTS_DIR
            )
        );
    }

    // ===== Lifecycle pass-through =========================================

    isReady(): boolean { return this.lifecycle.isReady(); }
    isAuthenticated(): boolean { return this.lifecycle.isAuthenticated(); }
    authenticate(): Promise<void> { return this.lifecycle.authenticate(); }
    initAsync(): Promise<void> { return this.lifecycle.initAsync(); }
    configFingerprint(): string { return this.lifecycle.configFingerprint(); }

    // ===== Live tree IO ===================================================

    async list(resource: SyncResource): Promise<RemoteEntry[]> {
        const dirPrefix = this.entryDirPrefixFor(resource);
        const blobEntries = await this.blob.list(dirPrefix);
        // Filter to well-formed `<id>.json` candidates BEFORE the
        // hydration pool — entry-mapper would otherwise fan out wasted
        // GET-body fallbacks on stray non-`.json` keys. Backends that
        // need stricter rules (File: cloud-mirror conflict patterns)
        // supply `entryNameFilter`.
        const candidates: { entry: typeof blobEntries[number]; id: string }[] = [];
        for (const e of blobEntries) {
            if (!e.path.endsWith('.json')) continue;
            const name = e.path.slice(dirPrefix.length);
            if (name.includes('/')) continue;
            if (this.entryNameFilter && !this.entryNameFilter(name)) continue;
            const id = name.slice(0, -5);
            if (!id) continue;
            candidates.push({ entry: e, id });
        }
        const out: RemoteEntry[] = new Array(candidates.length);
        await parallelPool(candidates, async (c, i) => {
            out[i] = await blobEntryToRemoteEntry(this.blob, c.entry, c.id);
        });
        return out;
    }

    read(resource: SyncResource, id: string): Promise<string> {
        return this.blob.read(this.entryPathFor(resource, id)).then(r => r.text);
    }

    write(resource: SyncResource, id: string, json: string, lastActiveAt: number): Promise<void> {
        if (!this.writesEntryMeta) {
            return this.blob.write(this.entryPathFor(resource, id), json);
        }
        return this.blob.write(this.entryPathFor(resource, id), json, {
            [META_LAST_ACTIVE]: String(lastActiveAt)
        });
    }

    remove(resource: SyncResource, id: string): Promise<void> {
        return this.blob.remove(this.entryPathFor(resource, id));
    }

    // ===== Tombstones =====================================================

    async listTombstones(resource: SyncResource): Promise<Tombstone[]> {
        if (this.hooks.onBeforeListTombstones) await this.hooks.onBeforeListTombstones(resource);
        return this.tombstones.list(resource);
    }

    async writeTombstone(resource: SyncResource, id: string, deletedAt: number): Promise<void> {
        if (this.hooks.onBeforeWriteTombstone) await this.hooks.onBeforeWriteTombstone(resource, id, deletedAt);
        return this.tombstones.write(resource, id, deletedAt);
    }

    async clearTombstones(resource: SyncResource): Promise<void> {
        if (this.hooks.onBeforeClearTombstones) await this.hooks.onBeforeClearTombstones(resource);
        return this.tombstones.clear(resource);
    }

    // ===== Settings / Prompts =============================================

    readSettings(): Promise<string | null> { return this.settings.read(); }
    writeSettings(content: string): Promise<void> { return this.settings.write(content); }
    readPrompts(): Promise<string | null> { return this.prompts.read(); }
    writePrompts(content: string): Promise<void> { return this.prompts.write(content); }

    // ===== Snapshots ======================================================

    listSnapshots(): Promise<SnapshotMeta[]> { return this.snapshots.listSnapshots(); }
    readSnapshotManifest(id: string): Promise<SnapshotManifest> { return this.snapshots.readSnapshotManifest(id); }
    createSnapshotFromCloud(id: string, meta: SnapshotMetaInput): Promise<SnapshotManifest> {
        return this.snapshots.createSnapshotFromCloud(id, meta);
    }
    createSnapshotFromLocal(id: string, meta: SnapshotMetaInput, payload: SnapshotLocalPayload): Promise<SnapshotManifest> {
        return this.snapshots.createSnapshotFromLocal(id, meta, payload);
    }
    restoreSnapshot(id: string): Promise<void> { return this.snapshots.restoreSnapshot(id); }
    deleteSnapshot(id: string): Promise<void> { return this.snapshots.deleteSnapshot(id); }
    updateSnapshotNote(id: string, note: string): Promise<void> {
        return this.snapshots.updateSnapshotNote(id, note);
    }
}
