import { Injectable, inject, signal } from '@angular/core';
import { KVStore } from '../kv/kv-store';
import { LLMConfigService } from '../llm-config.service';

/** Shared across all FileAgentService instances. Persists across sessions. */
export const FILE_AGENT_PROFILE_KEY = 'file_agent_profile_id';

/**
 * Singleton store for state that must stay in sync across every
 * FileAgentService instance:
 *
 * - `selectedProfileId`: the profile choice the user made for the file-agent.
 *   Without this store, each FileAgentService cached its own copy in a
 *   per-instance signal, so picking a profile in the file-viewer dialog
 *   didn't update the long-lived main-screen agent instance — the two would
 *   silently diverge (different default toolCallMode, different probe
 *   outcomes, different native vs JSON behaviour).
 * - `probeResults` / `parallelProbeResults`: same profile → same probe
 *   outcome. Caching here means the second instance reuses the first's
 *   verdict instead of racing a fresh probe.
 *
 * `agentLogs` / `agentHistory` are deliberately NOT in this store — each
 * file-agent surface (dialog vs main-screen) keeps its own conversation.
 */
@Injectable({ providedIn: 'root' })
export class FileAgentSettingsStore {
  private kv = inject(KVStore);
  private llmConfigService = inject(LLMConfigService);

  /** KV-backed; seeded from main-chat's active profile on first ever use. */
  readonly selectedProfileId = signal<string | null>(
    this.kv.get(FILE_AGENT_PROFILE_KEY) ?? this.llmConfigService.activeProfileId()
  );

  /** Per-profile native-tool-call probe verdict. In-memory only — re-probed once per session. */
  readonly probeResults = signal<Record<string, boolean>>({});

  /** Per-profile parallel-tool-call probe verdict. */
  readonly parallelProbeResults = signal<Record<string, boolean>>({});

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
}
