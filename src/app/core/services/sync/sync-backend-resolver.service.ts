import { Injectable, inject, signal } from '@angular/core';
import { SyncBackend, SyncBackendId } from './sync.types';
import { SYNC_BACKENDS } from './sync-backends.providers';

const LS_BACKEND = 'sync_backend';
const LS_AUTO_PREFIX = 'sync_auto_';

/**
 * Owner of "which backend is active" + per-backend auto-sync flags. A
 * thin facade over the multi-provider `SYNC_BACKENDS` array — there's no
 * id ladder here; `getActiveBackend` is `find + initAsync`.
 *
 * Auto-sync side effects (debounce cancel / failure-counter reset) on
 * `setActiveBackend` / `setAutoSyncEnabled` live in SyncService thin
 * wrappers — they belong with the scheduler state and will collapse
 * when AutoSyncScheduler is extracted.
 */
@Injectable({ providedIn: 'root' })
export class SyncBackendResolver {
    private readonly backends = inject(SYNC_BACKENDS);

    readonly activeBackendId = signal<SyncBackendId>(this.loadBackendId());
    readonly autoSyncEnabled = signal<Record<SyncBackendId, boolean>>(this.loadAutoFlags());

    /**
     * Look up the active backend, run its `initAsync`, hand it back. Throws
     * if the backend isn't registered (configuration bug) or not ready
     * (e.g. S3 not configured) — caller surfaces the error to the user.
     */
    async getActiveBackend(): Promise<SyncBackend> {
        const id = this.activeBackendId();
        const backend = this.backends.find(b => b.id === id);
        if (!backend) throw new Error(`SyncBackendResolver: no backend registered for id "${id}"`);
        await backend.initAsync();
        return backend;
    }

    /** Synchronous lookup without initAsync — for UI gating / status. */
    get(id: SyncBackendId): SyncBackend | null {
        return this.backends.find(b => b.id === id) ?? null;
    }

    isReady(id: SyncBackendId): boolean {
        return this.get(id)?.isReady() ?? false;
    }

    setActiveBackend(id: SyncBackendId): void {
        this.activeBackendId.set(id);
        localStorage.setItem(LS_BACKEND, id);
    }

    setAutoSyncEnabled(id: SyncBackendId, on: boolean): void {
        const next = { ...this.autoSyncEnabled(), [id]: on };
        this.autoSyncEnabled.set(next);
        localStorage.setItem(LS_AUTO_PREFIX + id, on ? '1' : '0');
    }

    private loadBackendId(): SyncBackendId {
        const stored = localStorage.getItem(LS_BACKEND);
        const match = this.backends.find(b => b.id === stored);
        return match?.id ?? 'gdrive';
    }

    /**
     * Per-backend auto-sync preference. Backends with
     * `supportsBackgroundSync = false` (currently File and GDrive)
     * always read as false regardless of any stale localStorage value —
     * the UI never offers the toggle for them.
     */
    private loadAutoFlags(): Record<SyncBackendId, boolean> {
        const flags = {} as Record<SyncBackendId, boolean>;
        for (const b of this.backends) {
            flags[b.id] = b.supportsBackgroundSync
                && localStorage.getItem(LS_AUTO_PREFIX + b.id) === '1';
        }
        return flags;
    }
}
