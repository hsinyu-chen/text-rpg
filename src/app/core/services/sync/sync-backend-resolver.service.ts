import { Injectable, computed, inject, signal } from '@angular/core';
import { AutoSyncMode, SyncBackend, SyncBackendId } from './sync.types';
import { SYNC_BACKENDS } from './sync-backends.providers';
import { KVStore } from '../kv/kv-store';

const LS_BACKEND = 'sync_backend';
const LS_AUTO_PREFIX = 'sync_auto_';

const VALID_MODES: ReadonlySet<AutoSyncMode> = new Set(['off', 'two-way', 'pull-only', 'push-only']);

/**
 * Owner of "which backend is active" + per-backend auto-sync mode. A
 * thin facade over the multi-provider `SYNC_BACKENDS` array — there's no
 * id ladder here; `getActiveBackend` is `find + initAsync`.
 *
 * `setActiveBackend` / `setAutoSyncMode` are pure persisters; the
 * AutoSyncScheduler-coupled side effects (debounce cancel / failure-
 * counter reset) live on SyncService thin wrappers that fan out to both
 * here and the scheduler. UI calls go through SyncService for that
 * single public surface; calling here directly skips the scheduler hook.
 */
@Injectable({ providedIn: 'root' })
export class SyncBackendResolver {
    private readonly backends = inject(SYNC_BACKENDS);
    private readonly kv = inject(KVStore);

    readonly activeBackendId = signal<SyncBackendId>(this.loadBackendId());
    readonly autoSyncMode = signal<Record<SyncBackendId, AutoSyncMode>>(this.loadAutoModes());
    /**
     * Derived boolean view of `autoSyncMode`: true iff the mode is one of
     * the active modes (anything but `'off'`). Retained because most
     * scheduler / UI gates only need "is auto-sync running at all".
     */
    readonly autoSyncEnabled = computed<Record<SyncBackendId, boolean>>(() => {
        const modes = this.autoSyncMode();
        const out = {} as Record<SyncBackendId, boolean>;
        for (const k of Object.keys(modes) as SyncBackendId[]) {
            out[k] = modes[k] !== 'off';
        }
        return out;
    });

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

    /** All registered backends in provider-declaration order. */
    list(): readonly SyncBackend[] {
        return this.backends;
    }

    isReady(id: SyncBackendId): boolean {
        return this.get(id)?.isReady() ?? false;
    }

    setActiveBackend(id: SyncBackendId): void {
        this.activeBackendId.set(id);
        this.kv.set(LS_BACKEND, id);
    }

    setAutoSyncMode(id: SyncBackendId, mode: AutoSyncMode): void {
        const next = { ...this.autoSyncMode(), [id]: mode };
        this.autoSyncMode.set(next);
        this.kv.set(LS_AUTO_PREFIX + id, mode);
    }

    private loadBackendId(): SyncBackendId {
        const stored = this.kv.get(LS_BACKEND);
        const match = this.backends.find(b => b.id === stored);
        return match?.id ?? 'gdrive';
    }

    /**
     * Per-backend auto-sync mode. Backends with
     * `supportsBackgroundSync = false` (currently GDrive) always read as
     * `'off'` regardless of any stale KVStore value — the UI never offers
     * the control for them.
     *
     * Legacy migration: the boolean iteration of this flag persisted `'1'`
     * for on and `'0'` for off. `'1'` upgrades in place to `'two-way'` so
     * existing users see the same effective behaviour after the upgrade.
     */
    private loadAutoModes(): Record<SyncBackendId, AutoSyncMode> {
        const flags = {} as Record<SyncBackendId, AutoSyncMode>;
        for (const b of this.backends) {
            if (!b.supportsBackgroundSync) { flags[b.id] = 'off'; continue; }
            const raw = this.kv.get(LS_AUTO_PREFIX + b.id);
            if (raw === '1') {
                flags[b.id] = 'two-way';
                this.kv.set(LS_AUTO_PREFIX + b.id, 'two-way');
            } else if (raw && (VALID_MODES as ReadonlySet<string>).has(raw)) {
                flags[b.id] = raw as AutoSyncMode;
            } else {
                flags[b.id] = 'off';
            }
        }
        return flags;
    }
}
