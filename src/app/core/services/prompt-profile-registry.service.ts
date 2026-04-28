import { Injectable, computed, inject, signal } from '@angular/core';
import { BUILT_IN_PROFILES, PromptProfile, USER_PROFILE_ID_PREFIX } from '../constants/prompt-profiles';
import { StorageService, StoredProfileMeta } from './storage.service';

/**
 * Registry of all known prompt profiles — built-in + user-defined.
 *
 * Built-ins come from `BUILT_IN_PROFILES` (read-only). User profiles are
 * persisted in IDB store `prompt_profile_meta` and merged in on `init()`,
 * which must complete before `InjectionService.loadDynamicInjectionSettings`
 * so the active profile id can resolve.
 *
 * `GameStateService` still owns `activePromptProfile` (which one is current);
 * this service owns "what profiles exist".
 */
@Injectable({ providedIn: 'root' })
export class PromptProfileRegistryService {
    private storage = inject(StorageService);

    private _profiles = signal<PromptProfile[]>([...BUILT_IN_PROFILES]);
    readonly profiles = this._profiles.asReadonly();
    readonly userProfiles = computed(() => this._profiles().filter(p => !p.isBuiltIn));
    readonly builtInProfiles = computed(() => this._profiles().filter(p => p.isBuiltIn));

    private initialized = false;

    /** Loads user profile metadata from IDB. Idempotent. */
    async init(): Promise<void> {
        if (this.initialized) return;
        try {
            const metas = await this.storage.listProfileMeta();
            const userProfiles = metas.map(metaToProfile);
            this._profiles.set([...BUILT_IN_PROFILES, ...userProfiles]);
        } catch (err) {
            console.error('[PromptProfileRegistry] init failed', err);
        } finally {
            this.initialized = true;
        }
    }

    get(id: string): PromptProfile | undefined {
        return this._profiles().find(p => p.id === id);
    }

    list(): PromptProfile[] {
        return this._profiles();
    }

    /** Add a user profile (must already be persisted via storage). */
    add(profile: PromptProfile): void {
        if (profile.isBuiltIn) {
            throw new Error('[PromptProfileRegistry] cannot add a built-in profile at runtime');
        }
        this._profiles.update(list => [...list, profile]);
    }

    /** Patch a user profile in-memory. Caller is responsible for persisting meta. */
    update(id: string, patch: Partial<PromptProfile>): void {
        this._profiles.update(list => list.map(p => p.id === id ? { ...p, ...patch } : p));
    }

    remove(id: string): void {
        this._profiles.update(list => list.filter(p => p.id !== id));
    }

    /** Generate a fresh user profile id. */
    static generateId(): string {
        const rand = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
            ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
            : Math.random().toString(36).slice(2, 14);
        return `${USER_PROFILE_ID_PREFIX}${rand}`;
    }
}

function metaToProfile(meta: StoredProfileMeta): PromptProfile {
    return {
        id: meta.id,
        isBuiltIn: false,
        subDir: null,
        displayName: meta.displayName,
        baseProfileId: meta.baseProfileId,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt
    };
}
