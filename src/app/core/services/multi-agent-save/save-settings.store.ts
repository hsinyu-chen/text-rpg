import { Injectable, inject, signal } from '@angular/core';
import { KVStore } from '../kv/kv-store';

const KEYS = {
    pauseBeforeAutoUpdate: 'mas_pause_before_auto_update',
    hunkFixupProfileId: 'mas_hunk_fixup_profile_id',
    enabledSaveAgents: 'mas_enabled_save_agents',
    saveAgentProfileIds: 'mas_save_agent_profile_ids',
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

    /**
     * Ids of {@link import('./advanced-save/advanced-save-agent').AdvancedSaveAgent}
     * the user has opted into. Each advanced-save agent costs an extra LLM call
     * per save, so every agent is off by default — the baseline hunk save (an
     * empty set ≡ identity advanced stage) is the safe default. Persisted as a
     * JSON string array; the key is absent when the set is empty.
     */
    private _enabledSaveAgents = signal<ReadonlySet<string>>(new Set());
    readonly enabledSaveAgents = this._enabledSaveAgents.asReadonly();

    /**
     * Per-agent LLM profile override for advanced-save agents, keyed by agent
     * id. A missing entry (or empty string) means the agent runs on the main
     * chat profile. Persisted as a JSON object; the key is absent when no
     * agent has an override.
     */
    private _saveAgentProfileIds = signal<Readonly<Record<string, string>>>({});
    readonly saveAgentProfileIds = this._saveAgentProfileIds.asReadonly();

    constructor() {
        // Any persisted non-empty value flips the diagnostic toggle on.
        // KVStore only stores strings, so we round-trip via 'true' / null.
        if (this.kv.get(KEYS.pauseBeforeAutoUpdate) === 'true') {
            this._pauseBeforeAutoUpdate.set(true);
        }

        const hunkFixupId = this.kv.get(KEYS.hunkFixupProfileId);
        if (hunkFixupId !== null) this._hunkFixupProfileId.set(hunkFixupId);

        const rawAgents = this.kv.get(KEYS.enabledSaveAgents);
        if (rawAgents) {
            try {
                const parsed: unknown = JSON.parse(rawAgents);
                if (Array.isArray(parsed)) {
                    this._enabledSaveAgents.set(new Set(parsed.filter((x): x is string => typeof x === 'string')));
                }
            } catch { /* corrupt value — fall back to the empty default */ }
        }

        const rawProfiles = this.kv.get(KEYS.saveAgentProfileIds);
        if (rawProfiles) {
            try {
                const parsed: unknown = JSON.parse(rawProfiles);
                if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    const kept = Object.entries(parsed as Record<string, unknown>)
                        .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '');
                    this._saveAgentProfileIds.set(Object.fromEntries(kept));
                }
            } catch { /* corrupt value — fall back to the empty default */ }
        }
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

    setEnabledSaveAgents(ids: ReadonlySet<string>): void {
        this._enabledSaveAgents.set(new Set(ids));
        // Persist a non-empty set only; clearing the key on empty keeps KVStore
        // small and matches the constructor's "absent ≡ no agents" read.
        if (ids.size > 0) this.kv.set(KEYS.enabledSaveAgents, JSON.stringify([...ids]));
        else this.kv.remove(KEYS.enabledSaveAgents);
    }

    setSaveAgentProfileIds(ids: Readonly<Record<string, string>>): void {
        // '' ≡ "same as main" ≡ absent — drop empties so the stored object
        // stays minimal and matches the constructor's "absent ≡ main" read.
        const pruned = Object.fromEntries(Object.entries(ids).filter(([, v]) => v !== ''));
        this._saveAgentProfileIds.set(pruned);
        if (Object.keys(pruned).length > 0) this.kv.set(KEYS.saveAgentProfileIds, JSON.stringify(pruned));
        else this.kv.remove(KEYS.saveAgentProfileIds);
    }
}
