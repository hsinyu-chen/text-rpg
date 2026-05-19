import { Injectable, inject, signal } from '@angular/core';
import { KVStore } from '../kv/kv-store';

export type SaveMode = 'legacy' | 'multi-agent';

export function isSaveMode(v: unknown): v is SaveMode {
    return v === 'legacy' || v === 'multi-agent';
}

const KEYS = {
    saveMode: 'mas_save_mode',
} as const;

/**
 * Multi-agent save subsystem settings. Kept separate from `AppConfigStore`
 * because the surface area will grow (Phase 1 will add `subToolProfileId`;
 * Phase 2 may add prompt-profile bindings) and the lifecycle is opt-in —
 * users who never enable multi-agent save shouldn't see these in the main
 * config snapshot.
 */
@Injectable({ providedIn: 'root' })
export class SaveSettingsStore {
    private kv = inject(KVStore);

    private _saveMode = signal<SaveMode>('legacy');
    readonly saveMode = this._saveMode.asReadonly();

    constructor() {
        const raw = this.kv.get(KEYS.saveMode);
        if (isSaveMode(raw)) this._saveMode.set(raw);
    }

    setSaveMode(mode: SaveMode): void {
        this._saveMode.set(mode);
        this.kv.set(KEYS.saveMode, mode);
    }
}
