import { Injectable, inject } from '@angular/core';
import { BookRepository } from '../storage/book.repository';
import { CollectionRepository } from '../storage/collection.repository';
import { Book, Collection, ROOT_COLLECTION_ID } from '@app/core/models/types';
import {
    SyncBackend, SyncResource, SnapshotLocalPayload,
    SyncReport, ForcePushReport, ForcePullReport
} from './sync.types';
import { cleanBookForSync, cleanCollectionForSync } from './clean.util';
import { errMsg } from './error.util';
import { PendingDeletion, SyncTombstoneTracker } from './tombstone-tracker.service';

export interface ReconcileResult {
    totals: SyncReport;
    downloadedBookIds: Set<string>;
    deletedBookIds: Set<string>;
}

export interface ForcePullResult {
    report: ForcePullReport;
    activeBookGone: boolean;
    activeBookOverwritten: boolean;
}

/**
 * Pure sync reconciliation engine. Owns the newer-wins decision tree, the
 * tombstone two-phase apply, the drift self-heal loop, and the local ↔
 * cloud entity (de)serialization. Stateless across runs except for the
 * `selfHealedIds` per-process cap.
 *
 * Doesn't touch the active session, the auto-sync scheduler, or the
 * inFlight mutex — those are SyncService concerns. Caller passes a ready-
 * to-use backend (already authenticated) and gets back the reconciliation
 * result; SyncService translates that into UI side-effects.
 */
@Injectable({ providedIn: 'root' })
export class SyncReconciler {
    private books = inject(BookRepository);
    private collections = inject(CollectionRepository);
    private tombstones = inject(SyncTombstoneTracker);

    /**
     * Per-process cap on self-heal re-uploads. If a backend mutates the
     * `last-active` metadata it round-trips (truncation, precision change,
     * proxy rewrite, etc.) we'd otherwise loop forever: download → mismatch
     * → re-upload → next sync's list() reports the mutated value again →
     * mismatch → re-upload. Once we've self-healed an id this session, we
     * trust it; any *real* drift that re-emerges later will flow through
     * the regular newer-wins path on the next process restart.
     */
    private selfHealedIds = new Set<string>();

    private getLocalList(resource: SyncResource): Promise<(Book | Collection)[]> {
        return resource === 'book'
            ? this.books.list()
            : this.collections.list();
    }

    async reconcileAll(backend: SyncBackend): Promise<ReconcileResult> {
        const totals: SyncReport = { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };
        const downloadedBookIds = new Set<string>();
        const deletedBookIds = new Set<string>();

        for (const resource of ['collection', 'book'] as const) {
            const r = await this.syncResource(backend, resource, downloadedBookIds, deletedBookIds);
            totals.uploaded += r.uploaded;
            totals.downloaded += r.downloaded;
            totals.deleted += r.deleted;
            totals.errors.push(...r.errors);
        }

        return { totals, downloadedBookIds, deletedBookIds };
    }

    async forcePushAll(backend: SyncBackend): Promise<ForcePushReport> {
        const report: ForcePushReport = { uploaded: 0, deletedRemote: 0, errors: [] };

        for (const resource of ['collection', 'book'] as const) {
            const localList = await this.getLocalList(resource);
            const localIds = new Set(localList.map(l => l.id));
            const remoteList = await backend.list(resource);
            const now = Date.now();

            // Wipe pre-existing tombstones first — local is the source of
            // truth, so any "this was deleted" record from another device
            // shouldn't keep haunting our entities. Then write fresh
            // tombstones below for entities we're deleting from the cloud
            // so other devices receive the message.
            //
            // Abort the resource if cleanup fails. Stale tombstones from
            // other devices typically lose to our fresh upload's lastActiveAt
            // (newer-wins), but if the user is force-pushing a restored-from-
            // snapshot entity its lastActiveAt may be older than the stale
            // tombstone's deletedAt — in which case other devices would
            // delete it on next sync. Force-push is destructive on intent;
            // failing loudly beats silent cross-device data loss.
            try {
                await backend.clearTombstones(resource);
            } catch (e) {
                console.error(`[Sync] forcePush: failed to clear tombstones for ${resource}, aborting resource`, e);
                report.errors.push({ resource, id: '', op: 'delete', message: errMsg(e) });
                continue;
            }

            for (const remote of remoteList) {
                if (localIds.has(remote.id)) continue;
                try {
                    await backend.remove(resource, remote.id);
                    // Tombstone so other devices learn this id was removed
                    // and don't resurrect it via local-only upload.
                    await backend.writeTombstone(resource, remote.id, now);
                    report.deletedRemote++;
                } catch (e) {
                    console.error(`[Sync] forcePush: failed to delete remote ${resource} ${remote.id}`, e);
                    report.errors.push({ resource, id: remote.id, op: 'delete', message: errMsg(e) });
                }
            }

            for (const local of localList) {
                try {
                    const cleaned = resource === 'book'
                        ? cleanBookForSync(local)
                        : cleanCollectionForSync(local);
                    const lastActiveAt = this.localTimestamp(cleaned, resource);
                    await backend.write(resource, local.id, JSON.stringify(cleaned), lastActiveAt);
                    report.uploaded++;
                } catch (e) {
                    console.error(`[Sync] forcePush: failed to upload ${resource} ${local.id}`, e);
                    report.errors.push({ resource, id: local.id, op: 'upload', message: errMsg(e) });
                }
            }
        }

        // Pending deletions are now redundant — anything we wanted gone is gone.
        this.tombstones.clearAll();

        return report;
    }

    async forcePullAll(backend: SyncBackend, activeBookId: string | null): Promise<ForcePullResult> {
        const report: ForcePullReport = { downloaded: 0, deletedLocal: 0, errors: [] };
        let activeBookGone = false;
        let activeBookOverwritten = false;

        for (const resource of ['collection', 'book'] as const) {
            const remoteList = await backend.list(resource);
            const remoteIds = new Set(remoteList.map(r => r.id));
            const localList = await this.getLocalList(resource);

            // Wipe local entries not on cloud (root collection is special — keep
            // it; it's rebuilt by ensureRoot if missing on cloud).
            for (const local of localList) {
                if (remoteIds.has(local.id)) continue;
                if (resource === 'collection' && local.id === ROOT_COLLECTION_ID) continue;
                try {
                    if (resource === 'book') {
                        if (local.id === activeBookId) activeBookGone = true;
                        await this.books.delete(local.id);
                    } else {
                        await this.collections.delete(local.id);
                    }
                    report.deletedLocal++;
                } catch (e) {
                    console.error(`[Sync] forcePull: failed to delete local ${resource} ${local.id}`, e);
                    report.errors.push({ resource, id: local.id, op: 'delete', message: errMsg(e) });
                }
            }

            // Overwrite local with cloud body for everything cloud has.
            for (const remote of remoteList) {
                try {
                    const json = await backend.read(resource, remote.id);
                    await this.applyRemote(resource, json);
                    if (resource === 'book' && remote.id === activeBookId) activeBookOverwritten = true;
                    report.downloaded++;
                } catch (e) {
                    console.error(`[Sync] forcePull: failed to download ${resource} ${remote.id}`, e);
                    report.errors.push({ resource, id: remote.id, op: 'download', message: errMsg(e) });
                }
            }
        }

        // Pending deletions are obsolete after a force pull.
        this.tombstones.clearAll();

        return { report, activeBookGone, activeBookOverwritten };
    }

    /**
     * Reads local IDB books / collections (cleaned for sync) and pending
     * deletions, packaged for `createSnapshotFromLocal`. Lives here because
     * it depends on the same `localTimestamp` rules and the tombstone
     * tracker — keeping it in SyncService would force re-importing both.
     */
    async collectLocalSnapshotPayload(): Promise<SnapshotLocalPayload> {
        const [books, collections] = await Promise.all([
            this.books.list(),
            this.collections.list()
        ]);
        const bookEntries = books.map(b => {
            const cleaned = cleanBookForSync(b);
            return {
                id: b.id,
                lastActiveAt: this.localTimestamp(cleaned, 'book'),
                json: JSON.stringify(cleaned)
            };
        });
        const collectionEntries = collections.map(c => {
            const cleaned = cleanCollectionForSync(c);
            return {
                id: c.id,
                lastActiveAt: this.localTimestamp(cleaned, 'collection'),
                json: JSON.stringify(cleaned)
            };
        });
        return {
            books: bookEntries,
            collections: collectionEntries,
            tombstones: this.tombstones.readAll()
        };
    }

    private async syncResource(
        backend: SyncBackend,
        resource: SyncResource,
        downloadedBookIds: Set<string>,
        deletedBookIds: Set<string>
    ): Promise<SyncReport> {
        const report: SyncReport = { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };

        let localList: (Book | Collection)[] = await this.getLocalList(resource);
        const remoteList = await backend.list(resource);
        const remoteById = new Map(remoteList.map(r => [r.id, r]));
        const localById = new Map(localList.map(l => [l.id, l]));

        // Pending deletions: write a tombstone (or update the existing one)
        // so other devices see the deletion, then drop the live object. Only
        // remove from the local tracking list once both succeed.
        // Use the deletedAt captured at delete-time — NOT Date.now() — so a
        // retry doesn't advance the timestamp and clobber a legitimate
        // post-delete edit on another device.
        const pending = this.tombstones.read(resource);
        const remaining: PendingDeletion[] = [];
        // Pre-seed with every pending id so the main loop won't resurrect
        // them even if writeTombstone fails — local already removed the
        // entity at delete-time, so a "remote-only → download" path would
        // bring it back. Items where tombstone *did* succeed are also in
        // here; that's a no-op skip.
        const justDeletedIds = new Set<string>(pending.map(p => p.id));
        for (const entry of pending) {
            let tombstoneWritten = false;
            try {
                await backend.writeTombstone(resource, entry.id, entry.deletedAt);
                tombstoneWritten = true;
            } catch (e) {
                console.error(`[Sync] Failed to write tombstone for ${resource} ${entry.id}, will retry`, e);
                report.errors.push({ resource, id: entry.id, op: 'delete', message: errMsg(e) });
            }

            let removeOk = true;
            if (tombstoneWritten && remoteById.has(entry.id)) {
                try {
                    await backend.remove(resource, entry.id);
                    remoteById.delete(entry.id);
                    report.deleted++;
                } catch (e) {
                    console.error(`[Sync] Failed to remove remote ${resource} ${entry.id}, will retry`, e);
                    report.errors.push({ resource, id: entry.id, op: 'delete', message: errMsg(e) });
                    removeOk = false;
                }
            }

            if (!tombstoneWritten || !removeOk) {
                remaining.push(entry);
            }
        }
        this.tombstones.write(resource, remaining);

        // Apply remote tombstones. For each tombstone, compute the newest
        // surviving timestamp on either side — if NEITHER side beat the
        // tombstone, both sides are pre-delete and need to go (deleting only
        // local would leave the cloud copy to resurrect on the next sync).
        // If either side is newer, that's a post-delete restore/edit — keep
        // it, let the regular newer-wins loop pick the winner.
        let tombstones;
        try {
            tombstones = await backend.listTombstones(resource);
        } catch (e) {
            // Abort the resource sync. Without a tombstone list we can't
            // tell whether a local-only item was deleted on another device,
            // so the main loop would resurrect it on cloud. Better to surface
            // the failure and retry next sync than silently undo a delete.
            console.error(`[Sync] Failed to list tombstones for ${resource}, aborting resource sync`, e);
            report.errors.push({ resource, id: '', op: 'list', message: errMsg(e) });
            return report;
        }
        for (const tomb of tombstones) {
            if (justDeletedIds.has(tomb.id)) continue;
            const local = localById.get(tomb.id);
            const remote = remoteById.get(tomb.id);
            if (!local && !remote) continue;
            const localTime = local ? this.localTimestamp(local, resource) : -Infinity;
            const remoteTime = remote ? remote.lastActiveAt : -Infinity;
            if (localTime > tomb.deletedAt || remoteTime > tomb.deletedAt) continue;
            // Mark as just-deleted *before* attempting any I/O so the
            // newer-wins loop below skips this id even on storage/backend
            // failure. Without this, a failed local delete would leave the
            // entity in localById and the main loop would re-upload it,
            // resurrecting on cloud. `deletedBookIds` is the opposite — it
            // only counts entries actually removed from IDB (caller uses it
            // to decide active-book reload).
            justDeletedIds.add(tomb.id);
            try {
                if (local) {
                    if (resource === 'book') {
                        await this.books.delete(tomb.id);
                        deletedBookIds.add(tomb.id);
                    } else {
                        await this.collections.delete(tomb.id);
                    }
                    localById.delete(tomb.id);
                    report.deleted++;
                }
                if (remote) {
                    await backend.remove(resource, tomb.id);
                    remoteById.delete(tomb.id);
                    report.deleted++;
                }
                console.log(`[Sync ${resource} ${tomb.id.slice(0, 8)}] tombstone wins → delete (local=${localTime}, remote=${remoteTime}, deletedAt=${tomb.deletedAt})`);
            } catch (e) {
                console.error(`[Sync] Failed to apply tombstone for ${resource} ${tomb.id}`, e);
                report.errors.push({ resource, id: tomb.id, op: 'delete', message: errMsg(e) });
            }
        }

        // Refresh localList in case tombstones removed entries.
        localList = Array.from(localById.values());

        // Single newer-wins loop over the union of local + remote ids.
        const allIds = new Set<string>([
            ...localList.map(l => l.id),
            ...remoteById.keys()
        ]);

        for (const id of allIds) {
            // SeaweedFS GET-after-DELETE consistency guard: don't try to read
            // an object we just removed within the same sync run, even if
            // it's still in the cached remoteList array. Also skips entities
            // we just locally-deleted via tombstone application.
            if (justDeletedIds.has(id)) continue;

            const local = localById.get(id);
            const remote = remoteById.get(id);

            if (local && !remote) {
                console.log(`[Sync ${resource} ${id.slice(0, 8)}] local-only → upload (local=${this.localTimestamp(local, resource)})`);
                await this.uploadEntity(backend, resource, local, report);
                continue;
            }
            if (!local && remote) {
                console.log(`[Sync ${resource} ${id.slice(0, 8)}] remote-only → download (remote=${remote.lastActiveAt})`);
                await this.downloadEntity(backend, resource, remote.id, remote.lastActiveAt, report, downloadedBookIds);
                continue;
            }
            if (local && remote) {
                const localTime = this.localTimestamp(local, resource);
                const remoteTime = remote.lastActiveAt;
                if (localTime > remoteTime) {
                    console.log(`[Sync ${resource} ${id.slice(0, 8)}] local newer → upload (local=${localTime}, remote=${remoteTime}, Δ=${localTime - remoteTime}ms)`);
                    await this.uploadEntity(backend, resource, local, report);
                } else if (remoteTime > localTime) {
                    console.log(`[Sync ${resource} ${id.slice(0, 8)}] remote newer → download (local=${localTime}, remote=${remoteTime}, Δ=${remoteTime - localTime}ms)`);
                    await this.downloadEntity(backend, resource, remote.id, remoteTime, report, downloadedBookIds);
                }
            }
        }

        return report;
    }

    private async uploadEntity(
        backend: SyncBackend,
        resource: SyncResource,
        local: Book | Collection,
        report: SyncReport
    ): Promise<void> {
        try {
            const cleaned = resource === 'book'
                ? cleanBookForSync(local)
                : cleanCollectionForSync(local);
            const lastActiveAt = this.localTimestamp(cleaned, resource);
            await backend.write(resource, local.id, JSON.stringify(cleaned), lastActiveAt);
            report.uploaded++;
        } catch (e) {
            console.error(`[Sync] Failed to upload ${resource} ${local.id}`, e);
            report.errors.push({ resource, id: local.id, op: 'upload', message: errMsg(e) });
        }
    }

    private async downloadEntity(
        backend: SyncBackend,
        resource: SyncResource,
        id: string,
        expectedRemoteLastActive: number,
        report: SyncReport,
        downloadedBookIds: Set<string>
    ): Promise<void> {
        try {
            const json = await backend.read(resource, id);
            const stored = await this.applyRemote(resource, json);
            report.downloaded++;
            if (resource === 'book') downloadedBookIds.add(id);

            // Self-heal: if the body's lastActiveAt differs from what list()
            // reported via metadata, the cloud's `last_active` metadata is
            // missing or stale (e.g., legacy upload from before the metadata
            // scheme). Re-upload with correct metadata so future syncs see a
            // matching remote/local time and stop looping in download.
            const bodyTime = this.localTimestamp(stored, resource);
            // 1000ms slack so a backend that truncates metadata to
            // second precision (or rounds in any sub-second way) doesn't
            // trigger a redundant re-upload every session. Legacy uploads
            // missing metadata fall back to either body extraction (where
            // bodyTime matches) or modifiedAt (where the gap is typically
            // minutes), both well outside this window.
            const drift = Math.abs(bodyTime - expectedRemoteLastActive);
            if (drift > 1000) {
                const healKey = `${resource}:${id}`;
                if (this.selfHealedIds.has(healKey)) {
                    console.warn(`[Sync ${resource} ${id.slice(0, 8)}] self-heal already attempted this session, skipping (body=${bodyTime}, expected=${expectedRemoteLastActive}); backend may be mutating metadata`);
                } else {
                    this.selfHealedIds.add(healKey);
                    console.warn(`[Sync ${resource} ${id.slice(0, 8)}] self-heal: body=${bodyTime} ≠ expected=${expectedRemoteLastActive} (Δ=${bodyTime - expectedRemoteLastActive}ms) → re-upload`);
                    await this.uploadEntity(backend, resource, stored, report);
                }
            }
        } catch (e) {
            console.error(`[Sync] Failed to download ${resource} ${id}`, e);
            report.errors.push({ resource, id, op: 'download', message: errMsg(e) });
        }
    }

    private localTimestamp(item: Book | Collection, resource: SyncResource): number {
        // Fallback to 0 for legacy IDB rows missing the timestamp field —
        // `undefined > N` returns false in both directions, so without this
        // a legacy entry would stall forever (never recognized as older or
        // newer than its remote counterpart).
        const ts = resource === 'book'
            ? (item as Book).lastActiveAt
            : (item as Collection).updatedAt;
        return ts || 0;
    }

    private async applyRemote(resource: SyncResource, json: string): Promise<Book | Collection> {
        if (resource === 'book') {
            const book = cleanBookForSync(JSON.parse(json));
            await this.books.save(book);
            return book;
        }
        const collection = cleanCollectionForSync(JSON.parse(json));
        await this.collections.save(collection);
        return collection;
    }
}
