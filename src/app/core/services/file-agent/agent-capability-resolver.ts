import { Signal, WritableSignal, computed, signal } from '@angular/core';
import { LLMConfig } from '@hcs/llm-core';
import { LLMProviderRegistryService } from '../llm-provider-registry.service';
import { KVStore } from '../kv/kv-store';
import { ToolCallMode } from './file-agent.types';

const TOOL_CALL_MODE_KEY_PREFIX = 'file_agent_tool_call_mode:';

export interface AgentCapabilityResolverDeps {
    selectedProfileId: Signal<string | null>;
    agentProfiles: Signal<LLMConfig[]>;
    llmProviderRegistry: LLMProviderRegistryService;
    kv: KVStore;
}

/**
 * Per-profile resolution of "native vs JSON tool calls" + "parallel tool
 * calls" capability. Priority order:
 *   explicit (additionalSettings) → probed (provider hook) → default (static)
 *
 * Owns the user-facing `toolCallMode` signal (auto / native / json) and
 * its KVStore persistence per profile id. Probe results are cached
 * per profile and feed back into the auto-mode resolution.
 *
 * Plain class (not @Injectable): instantiated by FileAgentService with
 * Signal references to its profile state, so the resolver's computeds
 * react to profile changes without needing its own dependency tree.
 */
export class AgentCapabilityResolver {
    private readonly probeResults = signal<Record<string, boolean>>({});
    private readonly parallelProbeResults = signal<Record<string, boolean>>({});

    readonly toolCallMode: WritableSignal<ToolCallMode>;

    constructor(private readonly deps: AgentCapabilityResolverDeps) {
        this.toolCallMode = signal<ToolCallMode>(
            this.loadToolCallMode(this.deps.selectedProfileId())
        );
    }

    private readonly activeProfile = computed<LLMConfig | null>(() => {
        const id = this.deps.selectedProfileId();
        return id ? this.deps.agentProfiles().find(p => p.id === id) ?? null : null;
    });

    /** True iff 'auto' would resolve to native for the selected profile. */
    readonly effectiveToolCallModeIsNative = computed<boolean>(() => {
        const setting = this.toolCallMode();
        if (setting === 'native') return true;
        if (setting === 'json') return false;
        return this.resolvedAutoIsNative().result;
    });

    /** Human-readable reason for the resolved auto mode — surfaced in UI tooltip. */
    readonly effectiveToolCallReason = computed<string>(() => {
        const setting = this.toolCallMode();
        if (setting === 'native') return 'forced Native';
        if (setting === 'json') return 'forced JSON';
        const r = this.resolvedAutoIsNative();
        return `Auto: ${r.result ? 'Native' : 'JSON'} (${r.source})`;
    });

    /** True iff the selected profile is allowed to issue multiple tool calls per turn. */
    readonly effectiveSupportsParallelToolCalls = computed<boolean>(() => {
        if (!this.effectiveToolCallModeIsNative()) return false;
        const profile = this.activeProfile();
        if (!profile) return false;

        const explicit = profile.settings.additionalSettings?.['supportsParallelToolCalls'];
        if (typeof explicit === 'boolean') return explicit;

        const probed = this.parallelProbeResults()[profile.id];
        if (typeof probed === 'boolean') return probed;

        const cap = this.deps.llmProviderRegistry.getProvider(profile.provider)?.getCapabilities(profile.settings);
        return !!cap?.supportsParallelToolCalls;
    });

    /**
     * Resolve auto-mode for the current profile with provenance:
     *   explicit  — user set additionalSettings.supportsNativeToolCalls
     *   probed    — async probe (e.g. llama.cpp chat_template) reported a verdict
     *   default   — fell back to provider's static capability
     *   no profile — nothing selected
     */
    private readonly resolvedAutoIsNative = computed<{ result: boolean; source: 'explicit' | 'probed' | 'default' | 'no profile' }>(() => {
        const profile = this.activeProfile();
        if (!profile) return { result: false, source: 'no profile' };

        const explicit = readExplicitNativeFlag(profile.settings);
        if (explicit !== undefined) return { result: explicit, source: 'explicit' };

        const probed = this.probeResults()[profile.id];
        if (typeof probed === 'boolean') return { result: probed, source: 'probed' };

        const cap = this.deps.llmProviderRegistry.getProvider(profile.provider)?.getCapabilities(profile.settings);
        return { result: !!cap?.supportsNativeToolCalls, source: 'default' };
    });

    setToolCallMode(mode: ToolCallMode): void {
        this.toolCallMode.set(mode);
        const id = this.deps.selectedProfileId();
        if (id) this.deps.kv.set(TOOL_CALL_MODE_KEY_PREFIX + id, mode);
    }

    /** Called by the owner when the active profile changes. */
    syncToolCallModeForProfile(profileId: string | null): void {
        this.toolCallMode.set(this.loadToolCallMode(profileId));
    }

    /**
     * Kick async probes for the given profile when its provider exposes
     * them and the user hasn't pinned an explicit flag. Results are cached
     * on `probeResults` / `parallelProbeResults` and feed into auto-mode
     * resolution. Errors are swallowed — falling back to the static
     * default is the safe behavior.
     */
    async kickToolSupportProbe(profileId: string): Promise<void> {
        const profile = this.deps.agentProfiles().find(p => p.id === profileId);
        if (!profile) return;

        const provider = this.deps.llmProviderRegistry.getProvider(profile.provider);
        if (!provider) return;

        if (readExplicitNativeFlag(profile.settings) === undefined && provider.probeNativeToolSupport) {
            try {
                const result = await provider.probeNativeToolSupport(profile.settings);
                this.probeResults.update(r => ({ ...r, [profileId]: result }));
            } catch {
                // Probe failures are non-fatal; fall back to defaults.
            }
        }

        const parallelExplicit = profile.settings.additionalSettings?.['supportsParallelToolCalls'];
        if (typeof parallelExplicit !== 'boolean' && provider.probeParallelToolSupport) {
            try {
                const result = await provider.probeParallelToolSupport(profile.settings);
                this.parallelProbeResults.update(r => ({ ...r, [profileId]: result }));
            } catch {
                // Probe failures are non-fatal; fall back to defaults.
            }
        }
    }

    private loadToolCallMode(profileId: string | null): ToolCallMode {
        if (!profileId) return 'auto';
        const v = this.deps.kv.get(TOOL_CALL_MODE_KEY_PREFIX + profileId);
        return v === 'native' || v === 'json' || v === 'auto' ? v : 'auto';
    }
}

function readExplicitNativeFlag(
    settings: { additionalSettings?: Record<string, unknown> }
): boolean | undefined {
    const v = settings.additionalSettings?.['supportsNativeToolCalls'];
    return typeof v === 'boolean' ? v : undefined;
}
