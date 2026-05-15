import { Injectable, inject, signal } from '@angular/core';
import { KVStore } from '../kv/kv-store';
import { LLMConfigService } from '../llm-config.service';

/** KV key for the file-agent's selected profile. Persists across sessions. */
export const FILE_AGENT_PROFILE_KEY = 'file_agent_profile_id';

/**
 * Singleton store for KV-backed file-agent settings + capability-probe
 * caches:
 *
 * - `selectedProfileId`: the profile choice the user made for the
 *   file-agent. KV-backed so the choice survives a reload.
 * - `probeResults` / `parallelProbeResults`: same profile → same probe
 *   outcome, so we cache once and let every consumer reuse the verdict
 *   instead of re-probing.
 *
 * Kept separate from `FileAgentService` (also a root singleton now) so the
 * probe-cache lifetime is decoupled from the agent loop's lifetime — the
 * agent can be torn down + recreated without losing the cached probe.
 */
@Injectable({ providedIn: 'root' })
export class FileAgentSettingsStore {
  private kv = inject(KVStore);
  private llmConfigService = inject(LLMConfigService);

  /** KV-backed; seeded from main-chat's active profile on first ever use. */
  readonly selectedProfileId = signal<string | null>(
    this.kv.get(FILE_AGENT_PROFILE_KEY) ?? this.llmConfigService.activeProfileId()
  );

  /**
   * Per-profile native-tool-call probe verdict. In-memory only. Success
   * verdicts are permanent within the session; failures land in
   * {@link probeFailureTimestamps} instead and self-clear after TTL so a
   * cold-start blip doesn't poison the cache.
   */
  readonly probeResults = signal<Record<string, boolean>>({});

  /** Per-profile parallel-tool-call probe verdict. */
  readonly parallelProbeResults = signal<Record<string, boolean>>({});

  /**
   * Timestamps of the last failed native-tool probe per profile. Used to
   * skip retries for a short window so a cold-start failure (llama.cpp not
   * warm yet at app-boot) doesn't keep getting re-fired by every effect
   * tick — but unlike `probeResults`, a failure DOESN'T poison the cache
   * forever: once the TTL elapses, the next kick re-attempts the probe.
   */
  readonly probeFailureTimestamps = signal<Record<string, number>>({});

  /** Mirror of {@link probeFailureTimestamps} for the parallel-tool probe. */
  readonly parallelProbeFailureTimestamps = signal<Record<string, number>>({});

  /**
   * Per-profile in-flight markers used to dedupe concurrent probe attempts
   * across sibling FileAgentService instances. The synchronous `in probeResults`
   * check inside the resolver doesn't block races: two instances can both
   * see the entry missing, both launch the (often network-backed) probe,
   * both write the same answer. These sets short-circuit the second caller.
   * Plain Sets, not signals — only the call-site inside kickToolSupportProbe
   * touches them and we don't want to thrash the reactive graph.
   */
  readonly probeInflight = new Set<string>();
  readonly parallelProbeInflight = new Set<string>();

  selectProfile(profileId: string | null): void {
    this.selectedProfileId.set(profileId);
    if (profileId) this.kv.set(FILE_AGENT_PROFILE_KEY, profileId);
    else this.kv.remove(FILE_AGENT_PROFILE_KEY);
  }

  recordProbeResult(profileId: string, native: boolean): void {
    this.probeResults.update(r => ({ ...r, [profileId]: native }));
  }

  recordParallelProbeResult(profileId: string, supports: boolean): void {
    this.parallelProbeResults.update(r => ({ ...r, [profileId]: supports }));
  }

  recordProbeFailure(profileId: string, at: number): void {
    this.probeFailureTimestamps.update(r => ({ ...r, [profileId]: at }));
  }

  recordParallelProbeFailure(profileId: string, at: number): void {
    this.parallelProbeFailureTimestamps.update(r => ({ ...r, [profileId]: at }));
  }

  clearProbeFailure(profileId: string): void {
    this.probeFailureTimestamps.update(r => {
      if (!(profileId in r)) return r;
      const next = { ...r };
      delete next[profileId];
      return next;
    });
  }

  clearParallelProbeFailure(profileId: string): void {
    this.parallelProbeFailureTimestamps.update(r => {
      if (!(profileId in r)) return r;
      const next = { ...r };
      delete next[profileId];
      return next;
    });
  }
}
