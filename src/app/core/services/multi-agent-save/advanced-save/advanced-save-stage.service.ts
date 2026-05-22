import { Injectable, inject } from '@angular/core';
import type { SaveHunk } from '../multi-agent-save.types';
import { SaveSettingsStore } from '../save-settings.store';
import { AdvancedSaveAgentRegistry } from './advanced-save-agent-registry';

/**
 * The advanced-save stage — a fixed post-processing step between the SaveAgent
 * manifest and AutoUpdateDialog.
 *
 * Runs every *enabled* {@link import('./advanced-save-agent').AdvancedSaveAgent}
 * in registration order, threading the hunk list through the chain:
 *   `hunks → agent[0] → agent[1] → … → final hunks`.
 *
 * Each agent receives the full current hunk list and returns the full
 * processed list (it filters what it cares about itself). A disabled agent is
 * skipped without disturbing the rest of the order. Zero enabled agents — the
 * Stage 2 baseline — makes the whole stage an identity pass.
 */
@Injectable({ providedIn: 'root' })
export class AdvancedSaveStageService {
    private registry = inject(AdvancedSaveAgentRegistry);
    private settings = inject(SaveSettingsStore);

    async process(hunks: SaveHunk[], signal: AbortSignal): Promise<SaveHunk[]> {
        const enabled = this.settings.enabledSaveAgents();
        let current = hunks;
        for (const agent of this.registry.all()) {
            if (!enabled.has(agent.id)) continue;
            // A cancel landing between agents shouldn't spend a fresh LLM call.
            signal.throwIfAborted();
            current = await agent.process({ hunks: current, signal });
        }
        return current;
    }
}
