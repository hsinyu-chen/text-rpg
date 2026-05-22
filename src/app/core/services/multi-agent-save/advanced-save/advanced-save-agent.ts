import { InjectionToken } from '@angular/core';
import type { ChatMessage } from '@app/core/models/types';
import type { SaveHunk } from '../multi-agent-save.types';

/**
 * Input handed to one {@link AdvancedSaveAgent} on the chain. The hunk list +
 * abort signal are the per-agent varying part; `files` / `chatMessages` /
 * `lang` are the shared turn context an LLM-driven agent needs for its
 * read tools and prompt loading.
 */
export interface AdvancedSaveAgentInput {
    /**
     * The full current hunk list — the previous agent's output, or the
     * SaveAgent manifest for the first agent on the chain.
     */
    hunks: SaveHunk[];
    /** Abort signal threaded from the save run's `AbortController`. */
    signal: AbortSignal;
    /** KB file snapshot — backs an LLM-driven agent's kb-read tools. */
    files: Map<string, string>;
    /** Current session chat — backs an LLM-driven agent's chat-read tools. */
    chatMessages: ChatMessage[];
    /** Output language — locale filename resolution + agent prompt loading. */
    lang: string;
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
    /**
     * i18n key base — an object node with `name` / `desc` / `aiHint` leaves.
     * Settings UI reads `.name` + `.desc`; the file-agent prompt reads
     * `.aiHint` to auto-describe this agent to the in-app KB assistant.
     */
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
 * The type parameter is the *collected* array, matching Angular's own
 * `HTTP_INTERCEPTORS` idiom for `multi: true` tokens: each Stage 3+ binding
 * contributes one agent, and `inject()` resolves the full array.
 */
export const ADVANCED_SAVE_AGENT = new InjectionToken<readonly AdvancedSaveAgent[]>('ADVANCED_SAVE_AGENT');
