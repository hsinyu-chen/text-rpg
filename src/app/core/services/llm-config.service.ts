import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { LLMConfig, LLMProviderConfig } from '@hcs/llm-core';
import { LLM_STORAGE_TOKEN } from '@hcs/llm-angular-common';

const ACTIVE_PROFILE_KEY = 'llm_active_profile_id';

/**
 * LLMConfigService — profile-aware bridge over the monorepo's IndexedDB
 * storage.
 *
 * The monorepo's LLMSettingsComponent manages the full CRUD lifecycle of
 * named profiles (each `LLMConfig` = `{id, name, provider, settings}`).
 * TextRPG's own job is just to remember *which* profile is active and
 * surface its `(provider, settings)` synchronously to everything else
 * (call sites, cost display, capability checks, etc.).
 *
 * A subscription to the storage keeps the in-memory cache fresh whenever
 * the profile list changes — including edits to the active profile made
 * from the profile manager.
 *
 * Seeding of profiles from the pre-monorepo per-key localStorage lives in
 * MigrationService.runMigrations, which must run before this service
 * initializes (see app.component bootstrap).
 */
@Injectable({ providedIn: 'root' })
export class LLMConfigService {
  private storage = inject(LLM_STORAGE_TOKEN);
  private destroyRef = inject(DestroyRef);

  private readonly _profiles = signal<LLMConfig[]>([]);
  private readonly _activeId = signal<string | null>(
    localStorage.getItem(ACTIVE_PROFILE_KEY)
  );

  readonly profiles = this._profiles.asReadonly();
  readonly activeProfileId = this._activeId.asReadonly();

  readonly activeProfile = computed<LLMConfig | null>(() => {
    const id = this._activeId();
    if (!id) {
      const list = this._profiles();
      return list.length > 0 ? list[0] : null;
    }
    return this._profiles().find(p => p.id === id) ?? null;
  });

  /** Provider name ('gemini' | 'llama.cpp' | 'openai' | …) of the active profile. */
  readonly activeProviderName = computed<string>(() => this.activeProfile()?.provider ?? 'gemini');

  /** Resolved promise after the first load of profiles from storage has finished. */
  private readonly ready: Promise<void>;

  constructor() {
    this.ready = this.initialize();
    // eslint-disable-next-line no-restricted-syntax -- LLMStorage exposes a callback subscribe(), not RxJS
    const unsubscribe = this.storage.subscribe(list => this._profiles.set(list));
    this.destroyRef.onDestroy(() => unsubscribe());
  }

  async waitReady(): Promise<void> {
    return this.ready;
  }

  private async initialize(): Promise<void> {
    // Profile seeding (from pre-monorepo per-key localStorage) runs in
    // MigrationService.runMigrations before this service initializes, so
    // we can assume storage is already in its post-migration state.
    const initial = await this.storage.getAll();
    this._profiles.set(initial);

    // If the active-id pointer is unset or points at a profile that no
    // longer exists (e.g. user deleted it), fall back to the first profile.
    if (initial.length > 0 && (!this._activeId() || !initial.find(p => p.id === this._activeId()))) {
      this.setActiveProfileId(initial[0].id);
    }
  }

  setActiveProfileId(id: string | null): void {
    this._activeId.set(id);
    if (id) {
      localStorage.setItem(ACTIVE_PROFILE_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
  }

  /** Active profile's provider settings, or an empty object if no profile. */
  getActiveConfig(): LLMProviderConfig {
    return this.activeProfile()?.settings ?? {};
  }

  /** Called by LLMProviderRegistryService so it can read the active provider name. */
  getActiveProviderName(): string {
    return this.activeProviderName();
  }

  /**
   * Patch the active profile's settings and persist. Used by the settings
   * import flow; UI-driven editing goes through LLMSettingsComponent which
   * talks to storage directly.
   */
  async saveActiveConfig(settings: LLMProviderConfig): Promise<void> {
    const current = this.activeProfile();
    if (!current) return;
    await this.storage.save({ ...current, settings });
  }

}
