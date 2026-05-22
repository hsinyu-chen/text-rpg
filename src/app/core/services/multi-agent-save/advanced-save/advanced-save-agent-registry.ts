import { Injectable, inject } from '@angular/core';
import { ADVANCED_SAVE_AGENT, type AdvancedSaveAgent } from './advanced-save-agent';

/**
 * Ordered registry of advanced-save agents. The order is the
 * {@link ADVANCED_SAVE_AGENT} multi-provider declaration order, used verbatim
 * by {@link import('./advanced-save-stage.service').AdvancedSaveStageService}
 * as the chain execution order, and by the settings UI to list per-agent
 * toggles.
 *
 * Stage 2 ships zero agent bindings — `all()` returns an empty array, so the
 * settings section stays hidden and the chain is an identity pass.
 */
@Injectable({ providedIn: 'root' })
export class AdvancedSaveAgentRegistry {
    // Zero bindings ⇒ the multi-token is unprovided ⇒ optional inject yields null.
    private readonly agents = inject(ADVANCED_SAVE_AGENT, { optional: true }) ?? [];

    /** All registered agents in registration (= execution) order. */
    all(): readonly AdvancedSaveAgent[] {
        return this.agents;
    }
}
