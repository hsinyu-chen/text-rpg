import type { LLMProvider, LLMProviderConfig } from '@hcs/llm-core';

/**
 * Resolve native-vs-JSON tool-call mode for an advanced-save agent's provider,
 * mirroring file-agent's `resolvedAutoIsNative` precedence:
 *
 *   1. **explicit** — the profile's `additionalSettings.supportsNativeToolCalls`
 *      (a user override) wins outright.
 *   2. **probed** — if the provider exposes `probeNativeToolSupport`, run a
 *      fresh probe (save agents don't share file-agent's per-profile cache).
 *   3. **default** — the provider's static `supportsNativeToolCalls` capability.
 *
 * The earlier save-agent code skipped straight to JSON whenever a provider had
 * no `probeNativeToolSupport` method — wrongly downgrading natively-capable
 * providers that simply don't need a probe (e.g. Gemini) to JSON. Step 3 is the
 * fix: absent a probe, fall back to the static capability, not JSON.
 */
export async function resolveAutoToolCallMode(
    provider: LLMProvider,
    config: LLMProviderConfig,
): Promise<'native' | 'json'> {
    const explicit = readExplicitNativeFlag(config);
    if (explicit !== undefined) return explicit ? 'native' : 'json';

    if (provider.probeNativeToolSupport) {
        try {
            return (await provider.probeNativeToolSupport(config)) ? 'native' : 'json';
        } catch {
            // Probe blipped (cold start, transient) — fall through to the
            // static capability rather than freezing a flake into JSON.
        }
    }

    return provider.getCapabilities(config).supportsNativeToolCalls ? 'native' : 'json';
}

/** The user's explicit native on/off override, or undefined when unset. */
function readExplicitNativeFlag(config: { additionalSettings?: Record<string, unknown> }): boolean | undefined {
    const v = config.additionalSettings?.['supportsNativeToolCalls'];
    return typeof v === 'boolean' ? v : undefined;
}
