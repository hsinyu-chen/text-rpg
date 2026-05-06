import { Injectable } from '@angular/core';
import { SnapshotLocalTombstone, SyncResource } from './sync.types';

export interface PendingDeletion {
    id: string;
    deletedAt: number;
}

const PENDING_DELETIONS_KEY: Record<SyncResource, string> = {
    book: 'pending_book_deletions',
    collection: 'pending_collection_deletions'
};

const ALL_RESOURCES = Object.keys(PENDING_DELETIONS_KEY) as SyncResource[];

/**
 * Local pending-deletion list per resource. A deletion is staged here at
 * the moment the user removes a book / collection on this device, then
 * propagated to cloud on the next sync as a tombstone + remote remove.
 *
 * Persisted to localStorage so the queue survives reload before sync runs.
 *
 * Distinct from the `Tombstone` type in sync.types.ts: that's the
 * cloud-confirmed tombstone other devices read; this is the local-only
 * intent that has not yet reached the cloud.
 */
@Injectable({ providedIn: 'root' })
export class SyncTombstoneTracker {
    /**
     * Stage a pending deletion. Same id deleted twice (re-add then delete)
     * updates the timestamp to the latest delete — that's the correct
     * latest-delete semantics. The deletedAt captured here is what later
     * propagates to cloud; sync retries must NOT advance it, otherwise a
     * retry could clobber a legitimate post-delete edit on another device.
     */
    track(resource: SyncResource, id: string): void {
        const list = this.read(resource);
        const idx = list.findIndex(e => e.id === id);
        const entry: PendingDeletion = { id, deletedAt: Date.now() };
        if (idx === -1) list.push(entry);
        else list[idx] = entry;
        this.write(resource, list);
    }

    /**
     * Read the current pending list. Tolerates the legacy string-array
     * shape (`['id1', 'id2']`) by upgrading entries to `{id, deletedAt:
     * Date.now()}` on read; the bumped timestamp is acceptable since the
     * old shape predates the timestamp tracking.
     *
     * **Side effect on corruption:** if the JSON parse throws, the entry
     * is treated as unrecoverable and cleared from localStorage on this
     * call — without it the same warning would fire on every subsequent
     * read. This is the only mutation `read` performs and only triggers
     * on broken data.
     */
    read(resource: SyncResource): PendingDeletion[] {
        const key = PENDING_DELETIONS_KEY[resource];
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            const now = Date.now();
            return parsed.flatMap(x => {
                if (typeof x === 'string') return [{ id: x, deletedAt: now }];
                if (x && typeof x === 'object' && typeof x.id === 'string') {
                    return [{ id: x.id, deletedAt: Number(x.deletedAt) || now }];
                }
                return [];
            });
        } catch {
            console.warn(`[SyncTombstoneTracker] Corrupted pending list at ${key}, resetting.`);
            localStorage.removeItem(key);
            return [];
        }
    }

    /**
     * Replace the pending list. Used after a sync run to drop entries that
     * were successfully propagated, keeping only those that still need
     * retry (tombstone write or remote remove failed).
     */
    write(resource: SyncResource, entries: PendingDeletion[]): void {
        localStorage.setItem(PENDING_DELETIONS_KEY[resource], JSON.stringify(entries));
    }

    /**
     * Drop everything. Called after force-push / force-pull / restore where
     * the pending list is no longer meaningful (force ops bypass the
     * tombstone propagation path).
     */
    clear(resource: SyncResource): void {
        this.write(resource, []);
    }

    /**
     * Drop pending lists for every resource. Convenience wrapper for the
     * force-push / force-pull / restore flows that always wipe both.
     */
    clearAll(): void {
        for (const r of ALL_RESOURCES) this.clear(r);
    }

    /**
     * Flatten all pending deletions across resources into the snapshot
     * payload shape. Used by the local snapshot builder so it doesn't have
     * to know which resources exist.
     */
    readAll(): SnapshotLocalTombstone[] {
        const all: SnapshotLocalTombstone[] = [];
        for (const r of ALL_RESOURCES) {
            for (const e of this.read(r)) {
                all.push({ resource: r, id: e.id, deletedAt: e.deletedAt });
            }
        }
        return all;
    }
}
