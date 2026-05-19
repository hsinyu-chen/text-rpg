import { Injectable, inject, signal } from '@angular/core';
import { KVStore } from '../kv/kv-store';

export type SaveMode = 'legacy' | 'multi-agent';

export function isSaveMode(v: unknown): v is SaveMode {
    return v === 'legacy' || v === 'multi-agent';
}

const KEYS = {
    saveMode: 'mas_save_mode',
    subToolProfileId: 'mas_sub_tool_profile_id',
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

    /**
     * LLM profile id used by Phase 2+ LLM-backed sub-tools (update_character /
     * update_faction). Empty string means "same as the main chat profile" —
     * the orchestrator falls back to the active LLMProvider config in that
     * case. Phase 1 stores the picker value but doesn't wire it (no LLM
     * sub-tools yet); persisting it now lets users pre-configure ahead of
     * Phase 2 without losing their selection across releases.
     */
    private _subToolProfileId = signal<string>('');
    readonly subToolProfileId = this._subToolProfileId.asReadonly();

    constructor() {
        const raw = this.kv.get(KEYS.saveMode);
        if (isSaveMode(raw)) this._saveMode.set(raw);

        const profileId = this.kv.get(KEYS.subToolProfileId);
        if (profileId !== null) this._subToolProfileId.set(profileId);
    }

    setSaveMode(mode: SaveMode): void {
        this._saveMode.set(mode);
        this.kv.set(KEYS.saveMode, mode);
    }

    setSubToolProfileId(id: string): void {
        this._subToolProfileId.set(id);
        this.kv.set(KEYS.subToolProfileId, id);
    }
}
