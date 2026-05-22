import { InjectionToken } from '@angular/core';
import type { SaveHunk } from '../multi-agent-save.types';

/**
 * Input handed to one {@link AdvancedSaveAgent} on the chain. Stage 2 carries
 * only the hunk list + abort signal; richer context (KB file snapshots,
 * chat messages, evidence anchors) lands with the first real agent in Stage 3a,
 * designed against that agent's actual needs.
 */
export interface AdvancedSaveAgentInput {
    /**
     * The full current hunk list — the previous agent's output, or the
     * SaveAgent manifest for the first agent on the chain.
     */
    hunks: SaveHunk[];
    /** Abort signal threaded from the save run's `AbortController`. */
    signal: AbortSignal;
}

/**
 * A post-processing step on the advanced-save chain. An agent receives the
 * full hunk list and returns the full processed list — it filters which hunks
 * it cares about itself (the framework has no file routing). It may add,
 * remove, or rewrite hunks, and target any file.
 *
 * Agents are deterministic or LLM-driven; the chain doesn't care. They run in
 * registration order (see {@link ADVANCED_SAVE_AGENT}).
 */
export interface AdvancedSaveAgent {
    /** Stable id — a member value of `enabledSaveAgents`, the settings toggle key. */
    readonly id: string;
    /** i18n key base — the settings UI reads `${i18nKey}.label` / `${i18nKey}.desc`. */
    readonly i18nKey: string;
    /** Takes the full hunk list, returns the full processed list. */
    process(input: AdvancedSaveAgentInput): Promise<SaveHunk[]>;
}

/**
 * Multi-provider token for advanced-save agents. The provider-declaration
 * order is the chain execution order — {@link AdvancedSaveAgentRegistry} reads
 * it verbatim. Stage 2 ships zero bindings, so the registry resolves an empty
 * list and the advanced-save stage is an identity pass.
 *
 * The type parameter is the *collected* array (Angular multi-provider idiom):
 * each Stage 3+ binding contributes one agent via `multi: true`.
 */
export const ADVANCED_SAVE_AGENT = new InjectionToken<readonly AdvancedSaveAgent[]>('ADVANCED_SAVE_AGENT');
