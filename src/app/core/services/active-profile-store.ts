import { Injectable, inject, signal } from '@angular/core';
import { KVStore } from './kv/kv-store';
import { DEFAULT_PROFILE_ID } from '../constants/prompt-profiles';

const KEY = 'app_active_prompt_profile';

/**
 * Which prompt profile is currently active. One field, but read from
 * three services (config, game-state, injection) so it earns a
 * dedicated store. Persistence is symmetric — set() updates the
 * signal AND the KV in lock-step.
 */
@Injectable({ providedIn: 'root' })
export class ActiveProfileStore {
    private kv = inject(KVStore);

    readonly id = signal<string>(DEFAULT_PROFILE_ID);

    constructor() {
        const stored = this.kv.get(KEY);
        if (stored) this.id.set(stored);
    }

    set(profileId: string): void {
        this.id.set(profileId);
        this.kv.set(KEY, profileId);
    }
}
