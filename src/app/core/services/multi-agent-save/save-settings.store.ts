import { Injectable, inject, signal } from '@angular/core';
import { KVStore } from '../kv/kv-store';

const KEYS = {
    pauseBeforeAutoUpdate: 'mas_pause_before_auto_update',
    hunkFixupProfileId: 'mas_hunk_fixup_profile_id',
} as const;

/**
 * Multi-agent save subsystem settings. Kept separate from `AppConfigStore`
 * because the lifecycle is opt-in — users who never touch these shouldn't
 * see them in the main config snapshot.
 */
@Injectable({ providedIn: 'root' })
export class SaveSettingsStore {
    private kv = inject(KVStore);

    /**
     * Diagnostic toggle. When `true`, `MultiAgentSaveService` keeps the
     * progress dialog open after the save run finishes and waits for the
     * user to close it manually before opening AutoUpdateDialog — so the
     * manifest trace stays inspectable. Default `false` keeps the production
     * flow (auto-close → auto-update jump) intact.
     */
    private _pauseBeforeAutoUpdate = signal<boolean>(false);
    readonly pauseBeforeAutoUpdate = this._pauseBeforeAutoUpdate.asReadonly();

    /**
     * LLM profile id used by the auto-update dialog's "LLM repair" button to
     * fix hunks whose `targetContent` doesn't appear verbatim in the source
     * file (e.g. the main LLM dropped a bold wrapper). Empty string falls back
     * to the active main chat profile.
     */
    private _hunkFixupProfileId = signal<string>('');
    readonly hunkFixupProfileId = this._hunkFixupProfileId.asReadonly();

    constructor() {
        // Any persisted non-empty value flips the diagnostic toggle on.
        // KVStore only stores strings, so we round-trip via 'true' / null.
        if (this.kv.get(KEYS.pauseBeforeAutoUpdate) === 'true') {
            this._pauseBeforeAutoUpdate.set(true);
        }

        const hunkFixupId = this.kv.get(KEYS.hunkFixupProfileId);
        if (hunkFixupId !== null) this._hunkFixupProfileId.set(hunkFixupId);
    }

    setPauseBeforeAutoUpdate(pause: boolean): void {
        this._pauseBeforeAutoUpdate.set(pause);
        // Persist 'true' only; clearing the key on `false` keeps KVStore
        // small and matches the constructor's "absent ≡ off" read.
        if (pause) this.kv.set(KEYS.pauseBeforeAutoUpdate, 'true');
        else this.kv.remove(KEYS.pauseBeforeAutoUpdate);
    }

    setHunkFixupProfileId(id: string): void {
        this._hunkFixupProfileId.set(id);
        this.kv.set(KEYS.hunkFixupProfileId, id);
    }
}
