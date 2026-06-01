import { Injectable, inject } from '@angular/core';
import type { AppLocale } from '@app/core/constants/locales/locale.interface';
import type { PromptType } from '../../../injection.service';
import { FACTION_PROVIDER } from '../../multi-agent-save.tokens';
import { BasePerEntityStateAgent, type PerEntityState } from './base-per-entity-state-agent';
import { FACTION_STATE_AGENT_ID } from './per-entity-agent-ids';
import { FactionTriageAgent } from './triage/faction-triage-agent';

export { FACTION_STATE_AGENT_ID };

/**
 * Per-entity state agent for `6.勢力與世界.md`. Job B for factions has no
 * physical-state analogue — it covers time-elapse faction dynamics (internal
 * movement, leadership shifts, inter-faction tension drift). That framing
 * lives in the system prompt (`save_faction_state`); this subclass only
 * supplies the wiring the base needs.
 */
@Injectable({ providedIn: 'root' })
export class FactionStateAgent extends BasePerEntityStateAgent {
    readonly id = FACTION_STATE_AGENT_ID;
    readonly i18nKey = 'advancedSaveAgents.factionState';
    protected readonly promptType: PromptType = 'save_faction_state';
    protected readonly traceLabel = 'FactionStateAgent';
    protected readonly triage = inject(FactionTriageAgent);

    private factionProvider = inject(FACTION_PROVIDER);

    protected resolveTargetFile(cf: AppLocale['coreFilenames']): string {
        return cf.WORLD_FACTIONS;
    }

    protected async listEntities(files: ReadonlyMap<string, string>): Promise<PerEntityState[]> {
        return this.factionProvider.listFactions(files);
    }
}
