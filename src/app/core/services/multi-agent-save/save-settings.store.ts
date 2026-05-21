import { Injectable, inject, signal } from '@angular/core';
import { KVStore } from '../kv/kv-store';

/**
 * Multi-agent save manifest mode.
 *
 * - `'1-call'` — main LLM emits the full manifest (incl. per-entity
 *   `updates` SectionUpdate[]). Single LLM call, KV-cache friendly.
 * - `'multi-call'` — main LLM only flags entities; a per-entity sub-agent
 *   (Phase B) projects each entity's diff under fog-of-war. Multiple LLM
 *   calls per save, slower but visibility-correct.
 *
 * Legacy KV values seen on persisted boots:
 * - `'legacy'`        — pre-Phase-A save model (intent → turn engine →
 *                       `<save>` XML). Migrated to `'1-call'`: the closest
 *                       behaviourally-equivalent mode in the new pipeline.
 * - `'multi-agent'`   — Phase 1's only mode (effectively 1-call after A1/A2).
 *                       Migrated to `'1-call'`.
 */
export type SaveMode = '1-call' | 'multi-call';

export function isSaveMode(v: unknown): v is SaveMode {
    return v === '1-call' || v === 'multi-call';
}

/**
 * Accepts the current schema plus the two pre-Phase-A values, normalising
 * legacy strings to `'1-call'`. Returns `null` only for genuinely unknown
 * input (typed-by-hand garbage), letting the caller fall back to the default.
 */
function migrateSaveMode(v: unknown): SaveMode | null {
    if (v === '1-call' || v === 'multi-call') return v;
    if (v === 'legacy' || v === 'multi-agent') return '1-call';
    return null;
}

const KEYS = {
    saveMode: 'mas_save_mode',
    subToolProfileId: 'mas_sub_tool_profile_id',
    pauseBeforeAutoUpdate: 'mas_pause_before_auto_update',
} as const;

/**
 * Multi-agent save subsystem settings. Kept separate from `AppConfigStore`
 * because the surface area will grow (Phase 1 added `subToolProfileId`;
 * Phase B will add per-entity sub-agent bindings) and the lifecycle is
 * opt-in — users who never enable a non-default mode shouldn't see these
 * in the main config snapshot.
 */
@Injectable({ providedIn: 'root' })
export class SaveSettingsStore {
    private kv = inject(KVStore);

    private _saveMode = signal<SaveMode>('1-call');
    readonly saveMode = this._saveMode.asReadonly();

    /**
     * LLM profile id used by the per-entity sub-agent (multi-call mode).
     * Empty string means "same as the main chat profile" — the orchestrator
     * falls back to the active LLMProvider config in that case. Stored
     * unconditionally so a user who pre-configures the picker before Phase B
     * lands doesn't lose the selection across releases.
     */
    private _subToolProfileId = signal<string>('');
    readonly subToolProfileId = this._subToolProfileId.asReadonly();

    /**
     * Diagnostic toggle. When `true`, `MultiAgentSaveService` keeps the
     * progress dialog open after the save run finishes and waits for the
     * user to close it manually before opening AutoUpdateDialog — so the
     * per-section trace stays inspectable for debugging the manifest /
     * dispatcher behaviour. Default `false` keeps the production flow
     * (auto-close → auto-update jump) intact.
     */
    private _pauseBeforeAutoUpdate = signal<boolean>(false);
    readonly pauseBeforeAutoUpdate = this._pauseBeforeAutoUpdate.asReadonly();

    constructor() {
        const raw = this.kv.get(KEYS.saveMode);
        const migrated = migrateSaveMode(raw);
        if (migrated) {
            this._saveMode.set(migrated);
            // Write the canonical value back so a subsequent boot sees the
            // new shape directly (skip the migration branch on warm reads).
            if (migrated !== raw) this.kv.set(KEYS.saveMode, migrated);
        }

        const profileId = this.kv.get(KEYS.subToolProfileId);
        if (profileId !== null) this._subToolProfileId.set(profileId);

        // Any persisted non-empty value flips the diagnostic toggle on.
        // KVStore only stores strings, so we round-trip via 'true' / null.
        if (this.kv.get(KEYS.pauseBeforeAutoUpdate) === 'true') {
            this._pauseBeforeAutoUpdate.set(true);
        }
    }

    setSaveMode(mode: SaveMode): void {
        this._saveMode.set(mode);
        this.kv.set(KEYS.saveMode, mode);
    }

    setSubToolProfileId(id: string): void {
        this._subToolProfileId.set(id);
        this.kv.set(KEYS.subToolProfileId, id);
    }

    setPauseBeforeAutoUpdate(pause: boolean): void {
        this._pauseBeforeAutoUpdate.set(pause);
        // Persist 'true' only; clearing the key on `false` keeps KVStore
        // small and matches the constructor's "absent ≡ off" read.
        if (pause) this.kv.set(KEYS.pauseBeforeAutoUpdate, 'true');
        else this.kv.remove(KEYS.pauseBeforeAutoUpdate);
    }
}
