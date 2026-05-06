import { Injectable } from '@angular/core';
import {
    SyncBackend, SnapshotMeta, SnapshotManifest, SnapshotMetaInput,
    SnapshotLocalPayload, SnapshotTrigger
} from './sync.types';
import { errMsg } from './error.util';

const LS_DEVICE_ID = 'sync_device_id';
/**
 * Cap on the number of auto-trigger snapshots kept on the cloud. Manual
 * snapshots are always preserved (the user pressed a button on purpose).
 * Anything beyond this cap, sorted oldest-first, is deleted on the next
 * createSnapshot success.
 */
const SNAPSHOT_AUTO_RETENTION = 20;
const RETENTION_DELETE_CONCURRENCY = 4;

/**
 * Thrown when the pre-op safety snapshot for forcePush / forcePull /
 * restore fails. The UI catches this to ask "snapshot failed — continue
 * anyway?", then re-invokes the same op with `skipSnapshot: true` /
 * `skipPreRestoreSnapshot: true`.
 */
export class SnapshotPreOpError extends Error {
    readonly trigger: 'forcePush' | 'forcePull' | 'preRestore';
    constructor(trigger: 'forcePush' | 'forcePull' | 'preRestore', message: string) {
        super(`Pre-${trigger} snapshot failed: ${message}`);
        this.name = 'SnapshotPreOpError';
        this.trigger = trigger;
        Object.setPrototypeOf(this, SnapshotPreOpError.prototype);
    }
}

/**
 * Snapshot CRUD + retention. Lives separately from SyncService because
 * snapshot lifecycle is independent of the per-resource sync state machine
 * (mutex, restore-in-progress, debounce). Backend resolution is wired via
 * a callback registered by SyncService at construction time so this service
 * stays out of the SyncService DI graph.
 *
 * The `restoreSnapshot` orchestrator stays on SyncService — it spans the
 * snapshot subsystem AND the sync state machine (cancelDebounce,
 * restoreInProgress, doForcePullAll), so splitting it here would just
 * push the entanglement back via callbacks.
 */
@Injectable({ providedIn: 'root' })
export class SnapshotService {
    private backendResolver: (() => Promise<SyncBackend>) | null = null;

    /**
     * Wire the backend resolver. Called by SyncService at construction so
     * this service can reach the active backend without injecting SyncService
     * (would form a circular dep).
     */
    registerBackendResolver(resolver: () => Promise<SyncBackend>): void {
        this.backendResolver = resolver;
    }

    private async getBackend(): Promise<SyncBackend> {
        if (!this.backendResolver) {
            throw new Error('SnapshotService: backend resolver not registered.');
        }
        const backend = await this.backendResolver();
        await backend.authenticate();
        return backend;
    }

    /**
     * Stable per-installation device id, surfaced into snapshot manifests so
     * the UI can label "this device" vs another. Generated lazily on first
     * use and persisted to localStorage; clearing storage rotates the id,
     * which is fine — older manifests just show the previous value verbatim.
     */
    getDeviceId(): string {
        let id = localStorage.getItem(LS_DEVICE_ID);
        if (!id) {
            id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
                ? crypto.randomUUID()
                : 'd-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem(LS_DEVICE_ID, id);
        }
        return id;
    }

    /**
     * `<ISO>-<4hex>` where the ISO has `:` and `.` swapped to `-` so the id
     * is path-safe on both S3 keys and Drive folder names. The 4-char hex
     * tail is collision protection at the same millisecond (~1/65536).
     * Backends only validate shape via assertSnapshotId; the format chosen
     * here is also lex-sortable, which keeps listSnapshots ordering cheap.
     */
    generateSnapshotId(): string {
        const iso = new Date().toISOString().replace(/[:.]/g, '-');
        const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
        return `${iso}-${rand}`;
    }

    private buildSnapshotMeta(trigger: SnapshotTrigger, note?: string): SnapshotMetaInput {
        return {
            createdAt: Date.now(),
            trigger,
            note,
            deviceId: this.getDeviceId()
        };
    }

    /**
     * Create a pre-op safety snapshot for forcePush / forcePull / restore.
     * `source='cloud'` snapshots cloud objects in place (server-side copy);
     * `source='local'` requires the caller-supplied builder because the
     * local payload (cleaned books / collections / tombstones) needs sync
     * internals to assemble. Wraps any failure in `SnapshotPreOpError` so
     * the UI's "snapshot failed — continue?" prompt fires uniformly.
     */
    async createPreOpSnapshot(
        trigger: 'forcePush' | 'forcePull' | 'preRestore',
        source: 'cloud' | 'local',
        localPayloadBuilder?: () => Promise<SnapshotLocalPayload>
    ): Promise<SnapshotManifest> {
        try {
            const backend = await this.getBackend();
            const id = this.generateSnapshotId();
            const meta = this.buildSnapshotMeta(trigger);
            if (source === 'cloud') {
                return await backend.createSnapshotFromCloud(id, meta);
            }
            if (!localPayloadBuilder) {
                throw new Error('source=local requires a payload builder');
            }
            const payload = await localPayloadBuilder();
            return await backend.createSnapshotFromLocal(id, meta, payload);
        } catch (e) {
            throw new SnapshotPreOpError(trigger, errMsg(e));
        }
    }

    /**
     * Manual snapshot: captures cloud (the shared state). If local has
     * unsynced changes the caller should sync first — surfaced in the UI
     * confirm dialog, not enforced here.
     *
     * Deliberately does NOT run inside `runExclusive`: a queued auto-sync
     * could otherwise wait minutes behind a slow CopyObject sweep and time
     * out the user. The cost is that an in-flight upload can race the
     * server-side copy, producing a snapshot whose objects are a mix of
     * pre- and post-upload state. Acceptable here because manual is a
     * convenience capture, not the rescue point for a destructive op
     * (those go through createPreOpSnapshot under the relevant lock).
     */
    async manualSnapshot(note?: string): Promise<SnapshotManifest> {
        const backend = await this.getBackend();
        const id = this.generateSnapshotId();
        const manifest = await backend.createSnapshotFromCloud(id, this.buildSnapshotMeta('manual', note));
        this.runRetentionInBackground();
        return manifest;
    }

    async listSnapshots(): Promise<SnapshotMeta[]> {
        const backend = await this.getBackend();
        return backend.listSnapshots();
    }

    async deleteSnapshot(snapshotId: string): Promise<void> {
        const backend = await this.getBackend();
        await backend.deleteSnapshot(snapshotId);
    }

    async updateSnapshotNote(snapshotId: string, note: string): Promise<void> {
        const backend = await this.getBackend();
        await backend.updateSnapshotNote(snapshotId, note);
    }

    /**
     * Runs in the background (fire-and-forget) after every snapshot create.
     * Auto-trigger snapshots beyond `SNAPSHOT_AUTO_RETENTION` are deleted
     * oldest-first. Manual snapshots are excluded — the user explicitly
     * pressed a button on those, retention shouldn't surprise-delete them.
     */
    runRetentionInBackground(): void {
        void this.runRetention().catch(e => {
            console.warn('[SnapshotService] Retention sweep failed (non-fatal)', e);
        });
    }

    private async runRetention(): Promise<void> {
        const backend = await this.getBackend();
        const all = await backend.listSnapshots();
        const auto = all.filter(s => s.trigger !== 'manual')
            .sort((a, b) => b.createdAt - a.createdAt);
        const excess = auto.slice(SNAPSHOT_AUTO_RETENTION);
        if (excess.length === 0) return;
        let cursor = 0;
        const runners = Array.from(
            { length: Math.min(RETENTION_DELETE_CONCURRENCY, excess.length) },
            async () => {
                while (cursor < excess.length) {
                    const i = cursor++;
                    try {
                        await backend.deleteSnapshot(excess[i].id);
                    } catch (e) {
                        console.warn(`[SnapshotService] Retention: failed to delete ${excess[i].id}`, e);
                    }
                }
            }
        );
        await Promise.all(runners);
    }
}
